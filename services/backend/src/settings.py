from pydantic import SecretStr
from generated.settings import Settings as GeneratedSettings


class Settings(GeneratedSettings):
    portfolio_origin: str = "http://localhost:8080"
    oidc_issuer: str = ""
    oidc_client_id: str = ""
    oidc_client_secret: SecretStr = SecretStr("")
    s3_public_base: str = ""
