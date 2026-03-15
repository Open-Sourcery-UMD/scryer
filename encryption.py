import os
import base64
import hashlib
from cryptography.fernet import Fernet


class EncryptionUtil:

    @staticmethod
    def buildCipher(secret):
        key_bytes = hashlib.sha256(secret.encode()).digest()
        return Fernet(base64.urlsafe_b64encode(key_bytes))

    @staticmethod
    def encrypt(plaintext, key):
        if not key:
            key = os.getenv("MASTER_KEY")
            if not key:
                raise ValueError("MASTER_KEY environment variable has not been set")

        cipher = EncryptionUtil.buildCipher(key)
        return cipher.encrypt(plaintext.encode()).decode()

    @staticmethod
    def decrypt(ciphertext, key):
        if not key:
            key = os.getenv("MASTER_KEY")
            if not key:
                raise ValueError("MASTER_KEY environment variable has not been set")

        cipher = EncryptionUtil.buildCipher(key)
        return cipher.decrypt(ciphertext.encode()).decode()