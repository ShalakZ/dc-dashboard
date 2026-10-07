import os

from cryptography.fernet import Fernet

os.environ.setdefault("DCDASH_SECRET_KEY", Fernet.generate_key().decode())
