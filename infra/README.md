# 部署：ECS + Tailscale + NAT instance

依照設計文件「附錄：ECS + Tailscale 版本（採用方案）」建立。網站只讓加入公司 Tailscale 的人連線，沒有 ALB，也沒有 NAT Gateway。

| 元件 | Terraform 檔案 | 說明 |
| --- | --- | --- |
| VPC、子網路、gateway endpoint、Cloud Map | `network.tf` | 2 個 AZ；私有子網路放網站容器；S3／DynamoDB 走免費 gateway endpoint |
| Router + NAT | `router.tf`、`router-user-data.sh.tftpl` | 一台 t4g.micro，ASG 最少 1 台；開機時接管私有路由表的 0.0.0.0/0，並以 `tailscale serve` 提供 HTTPS 網址 |
| 網站服務 | `ecs.tf` | FastAPI 在 Fargate（arm64），沒有公開 IP，只接受 VPC 內的連線 |
| 比對 | `lambda.tf`、`data.tf` | SQS（batch 1）觸發 Lambda；可見逾時 = 6 × Lambda timeout；失敗 3 次進 DLQ |
| 資料 | `data.tf` | S3（1 天 lifecycle、CORS 只允許網站網址）、DynamoDB（TTL 24 小時） |
| 登入 | `cognito.tf` | 管理員建立帳號；code + PKCE；access token 1 小時、refresh token 12 小時 |

## 連線方式

員工電腦連上 Tailscale 後開啟 `https://redline-diff.<tailnet>.ts.net`（tailnet 名稱見 Tailscale 管理後台的 DNS 頁面；機器名稱由 `tailscale_hostname` 設定，預設 `redline-diff`）。這個網址由 router 上的 `tailscale serve` 提供（Tailscale 自動簽發的憑證），再轉到私有子網路的 `web.redline-diff.internal:8000`（Cloud Map DNS，容器換 IP 也不影響）。router 也會分享整個 VPC 網段，方便管理員直接連到內部 IP。

之所以一定要 HTTPS 網址：Cognito 的登入回呼網址必須是 https，瀏覽器的 PKCE 加密功能也只在 HTTPS 下可用。

## 第一次部署

### 1. Tailscale 準備（管理後台）

1. **DNS**：開啟 MagicDNS 與 HTTPS Certificates，記下 tailnet 名稱（例如 `tail1234.ts.net`）。
2. **Access controls**：加入 tag 與自動核准路由，例如：
   ```json
   "tagOwners":     { "tag:redline-diff-router": ["autogroup:admin"] },
   "autoApprovers": { "routes": { "10.40.0.0/16": ["tag:redline-diff-router"] } }
   ```
   並確認員工可以連到 `tag:redline-diff-router` 的 443 埠（預設的 allow-all 已包含）。
3. **Keys**：建立 auth key，勾選 Reusable、Ephemeral、Pre-approved，Tags 選 `tag:redline-diff-router`。Ephemeral 讓舊機器離線後自動移除，替換的 router 才能沿用同一個名稱。
4. 把 key 存進 SSM Parameter Store（不會進 Terraform state）：
   ```sh
   aws ssm put-parameter --region ca-central-1 --name /redline-diff/tailscale-auth-key --type SecureString --value 'tskey-auth-...'
   ```

subnet router、HTTPS、SSO 分別包含在哪些 Tailscale 方案，請先到官網確認。

### 2. 建立 ECR 並推送映像檔

```sh
cd infra
cp terraform.tfvars.example terraform.tfvars   # 填入 region、tailnet_dns_name、cognito_domain_prefix
terraform init
terraform apply -target=aws_ecr_repository.web -target=aws_ecr_repository.compare -var image_tag=bootstrap
cd .. && TAG=$(scripts/push-images.sh ca-central-1) && echo $TAG
```

需要 Docker buildx（會建置 linux/arm64 映像檔）。把印出的 tag 填進 `terraform.tfvars` 的 `image_tag`。

### 3. 建立其餘資源

```sh
cd infra && terraform apply
```

完成後 `terraform output site_url` 就是網站網址。router 開機約需 2 到 3 分鐘：先接管 NAT 路由，再加入 Tailscale。

### 4. 建立使用者

```sh
aws cognito-idp admin-create-user --region ca-central-1 \
  --user-pool-id $(terraform output -raw cognito_user_pool_id) \
  --username someone@company.com --user-attributes Name=email,Value=someone@company.com Name=email_verified,Value=true
```

使用者會收到暫時密碼，第一次登入時設定新密碼。

## 更新程式

```sh
TAG=$(scripts/push-images.sh ca-central-1)
cd infra && terraform apply -var image_tag=$TAG
```

映像檔 tag 不可覆寫，每次部署都會用新 tag。網站容器開 2 個時更新不會中斷；只開 1 個（`web_desired_count = 1`）會短暫中斷。

## 維運

- **router 故障**：ASG 自動重建，中斷約幾分鐘。只偵測 EC2 狀態檢查；若 Tailscale 程序異常但機器正常，需手動在 EC2 主控台終止該 instance 讓 ASG 重建。
- **登入 router**：用 Systems Manager Session Manager（不開 SSH）。
- **系統更新**：router 每天自動套用安全性更新（dnf-automatic）。換新 AMI：`terraform apply` 後 ASG 會以 instance refresh 替換。
- **比對失敗**：看 CloudWatch Logs `/aws/lambda/redline-diff-compare`；超過 3 次失敗的訊息在 DLQ。執行超過 Lambda 上限的工作，網站會顯示失敗。
- **改用 NAT Gateway**：建立 NAT Gateway，把私有路由表的 0.0.0.0/0 改指向它，再移除 router 開機腳本中的 replace-route。應用程式不用改。

## 檢查

```sh
terraform fmt -check -recursive
terraform init -backend=false && terraform validate && terraform test   # 不需 AWS 帳號
```

## 待確認

- Lambda 記憶體（預設 3008 MB）與 15 分鐘上限：用最大、最複雜的圖面實測後調整 `compare_memory_mb`。新帳號的 Lambda 記憶體上限可能是 3008 MB，需要更多時要向 AWS 申請。
- 部署區域：範例用 `ca-central-1`。
- Cognito 帳號來源：目前由管理員建立，日後可串接公司 SSO 或改用 Tailscale 身分。
