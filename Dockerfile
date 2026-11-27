# ECS web service: FastAPI (static site + job API). Build for linux/arm64 (Graviton Fargate).
FROM node:22-slim AS pdfjs
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt requirements-web.txt ./
RUN pip install --no-cache-dir -r requirements-web.txt
COPY --from=pdfjs /src/node_modules/pdfjs-dist node_modules/pdfjs-dist
COPY compare.py ./
COPY redline_diff redline_diff
COPY static static
RUN useradd --system --uid 10001 redline-diff
USER redline-diff
EXPOSE 8000
CMD ["uvicorn", "--factory", "redline_diff.app:create_app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--no-server-header"]
