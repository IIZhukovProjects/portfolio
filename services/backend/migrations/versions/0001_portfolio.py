"""Create content and OIDC session tables."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0001_portfolio"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "portfolio_content",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("document", JSONB, nullable=False),
        sa.CheckConstraint("id = 1"),
    )
    op.create_table(
        "portfolio_login",
        sa.Column("digest", sa.String(64), primary_key=True),
        sa.Column("state", sa.String(64), nullable=False),
        sa.Column("verifier", sa.String(100), nullable=False),
        sa.Column("nonce", sa.String(64), nullable=False),
        sa.Column("expires", sa.BigInteger, nullable=False, index=True),
    )
    op.create_table(
        "portfolio_session",
        sa.Column("digest", sa.String(64), primary_key=True),
        sa.Column("subject", sa.String(100), nullable=False),
        sa.Column("token", sa.LargeBinary, nullable=False),
        sa.Column("csrf", sa.String(64), nullable=False),
        sa.Column("expires", sa.BigInteger, nullable=False, index=True),
    )


def downgrade():
    for name in ("portfolio_session", "portfolio_login", "portfolio_content"):
        op.drop_table(name)
