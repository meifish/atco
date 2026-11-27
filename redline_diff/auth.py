"""Cognito access-token verification done by FastAPI itself (there is no ALB).

The browser sends the Cognito access token as `Authorization: Bearer ...`.
We check signature (JWKS), issuer, expiry, token_use and client_id, and use
the `sub` claim as the user id.
"""
from dataclasses import dataclass
import re

import jwt


class AuthError(Exception):
    pass


@dataclass(frozen=True)
class User:
    id: str
    email: str = ''


LOCAL_USER = User(id='local', email='')
_SUB = re.compile(r'^[A-Za-z0-9-]{1,128}$')


class CognitoVerifier:
    def __init__(self, region, user_pool_id, client_id, jwks_client=None):
        self.issuer = f'https://cognito-idp.{region}.amazonaws.com/{user_pool_id}'
        self.client_id = client_id
        self.jwks = jwks_client or jwt.PyJWKClient(self.issuer + '/.well-known/jwks.json',
                                                   cache_keys=True, lifespan=3600)

    def verify(self, authorization):
        if not authorization or not authorization.startswith('Bearer '):
            raise AuthError('missing token')
        token = authorization[7:].strip()
        try:
            key = self.jwks.get_signing_key_from_jwt(token).key
            claims = jwt.decode(token, key, algorithms=['RS256'], issuer=self.issuer,
                                options={'require': ['exp', 'iat', 'sub', 'token_use'], 'verify_aud': False},
                                leeway=30)
        except jwt.PyJWTError as error:
            raise AuthError(str(error)) from error
        if claims.get('token_use') != 'access' or claims.get('client_id') != self.client_id:
            raise AuthError('wrong token type or client')
        if not _SUB.match(claims['sub']):
            raise AuthError('invalid subject')
        return User(id=claims['sub'], email=claims.get('username', ''))


class LocalVerifier:
    """Local mode has no login: one user, bound to 127.0.0.1 only."""

    def verify(self, authorization):
        return LOCAL_USER
