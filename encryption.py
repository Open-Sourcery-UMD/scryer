import os
import base64
import hashlib
from cryptography.fernet import Fernet


class EncryptionUtil:
    SALT_SIZE = 16
    ITERATIONS = 200_000

    @staticmethod
    def buildCipher(secret, salt):
        key_bytes = hashlib.pbkdf2_hmac(
            "sha256",
            secret.encode(),
            salt,
            EncryptionUtil.ITERATIONS,
            dklen=32,
        )
        return Fernet(base64.urlsafe_b64encode(key_bytes))

    @staticmethod
    def encrypt(plaintext, key):
        if not key:
            raise ValueError("Encryption key must be provided")

        salt = os.urandom(EncryptionUtil.SALT_SIZE)
        cipher = EncryptionUtil.buildCipher(key, salt)
        encrypted = cipher.encrypt(plaintext.encode())

        return base64.urlsafe_b64encode(salt + encrypted).decode()

    @staticmethod
    def decrypt(ciphertext, key):
        if not key:
            raise ValueError("Encryption key must be provided")

        raw = base64.urlsafe_b64decode(ciphertext.encode())
        salt = raw[:EncryptionUtil.SALT_SIZE]
        encrypted = raw[EncryptionUtil.SALT_SIZE:]

        cipher = EncryptionUtil.buildCipher(key, salt)
        return cipher.decrypt(encrypted).decode()