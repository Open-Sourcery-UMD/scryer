import os
import unittest
from encryption import EncryptionUtil


class UnitTest(unittest.TestCase):
    def test_encrypt_decrypt(self):
        os.environ["MASTER_KEY"] = "my-secret-key"
        text = "I have $395,000 in my bank account!!"

        encrypted = EncryptionUtil.encrypt(text, None)
        decrypted = EncryptionUtil.decrypt(encrypted, None)

        self.assertEqual(decrypted, text)
    
if __name__ == "__main__":
    unittest.main()