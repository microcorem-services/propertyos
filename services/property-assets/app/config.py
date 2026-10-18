import os


SERVICE_NAME = "property-assets"
SERVICE_PORT = int(os.getenv("SERVICE_PORT", "8102"))
DATABASE_URL = os.getenv("DATABASE_URL", "")