import os


SERVICE_NAME = "organization-access"
SERVICE_PORT = int(os.getenv("SERVICE_PORT", "8101"))
DATABASE_URL = os.getenv("DATABASE_URL", "")