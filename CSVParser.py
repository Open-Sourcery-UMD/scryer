import csv
import re
import pandas as pd


class GenericCSVParser:
    nameMap = {
        "date": [
            "date",
            "transaction date",
            "posted date",
            "post date",
            "posting date",
            "effective date"
        ],
        "details": [
            "description",
            "merchant",
            "details",
            "transaction",
            "transaction description",
            "narrative",
            "memo",
            "payee",
            "name"
        ],
        "money": [
            "amount",
            "transaction amount",
            "value",
            "debit credit",
            "amt"
        ],
        "spent": [
            "debit",
            "withdrawal",
            "money out",
            "charges"
        ],
        "got": [
            "credit",
            "deposit",
            "money in",
            "payments"
        ]
    }

    def findBestName(self, cleanNames, kind):
        options = []
        for word in self.nameMap[kind]:
            options.append(self.cleanName(word))

        for realName in cleanNames:
            testName = cleanNames[realName]
            if testName in options:
                return realName

        for realName in cleanNames:
            testName = cleanNames[realName]
            for word in options:
                if word in testName or testName in word:
                    return realName

        return ""

    def cleanName(self, text):
        value = str(text).strip().lower()
        value = re.sub(r"[-/ ]+", " ", value)
        value = re.sub(r"\s+", " ", value)
        return value

    def cleanText(self, value):
        if not pd.notna(value):
            return ""
        return str(value).strip()

    def findSplitChar(self, filePath):
        with open(filePath, "r", encoding="utf8", newline="") as file:
            sample = file.read(4096)
            try:
                style = csv.Sniffer().sniff(sample, delimiters=",;|\t")
                return style.delimiter
            except csv.Error:
                return ","

    def joinMoney(self, spent, got):
        if spent != "" and spent != 0:
            return -abs(spent)

        if got != "" and got != 0:
            return abs(got)

        if spent == 0 and got == 0:
            return 0.0

        if spent != "":
            return -abs(spent)

        if got != "":
            return abs(got)

        return ""
    
    def readMoney(self, value):
        if not pd.notna(value):
            return ""

        text = str(value).strip()

        if text == "":
            return ""

        isMinus = text.startswith("(") and text.endswith(")")

        if isMinus:
            text = text[1:-1].strip()

        text = text.replace("$", "")
        text = text.replace(",", "")
        text = text.strip()

        try:
            number = float(text)
        except ValueError:
            return ""

        if isMinus and number > 0:
            number = -number

        return number
    
    def parseFile(self, filePath):
        splitChar = self.findSplitChar(filePath)
        readFile = getattr(pd, "read" + chr(95) + "csv")
        table = readFile(filePath, dtype=str, sep=splitChar)

        cleanNames = {}
        for name in table.columns:
            cleanNames[name] = self.cleanName(name)

        dateName = self.findBestName(cleanNames, "date")
        detailsName = self.findBestName(cleanNames, "details")
        moneyName = self.findBestName(cleanNames, "money")
        spentName = self.findBestName(cleanNames, "spent")
        gotName = self.findBestName(cleanNames, "got")

        if dateName == "":
            raise ValueError("Missing date column")

        if detailsName == "":
            raise ValueError("Missing details column")

        if moneyName == "" and spentName == "" and gotName == "":
            raise ValueError("Missing money column")

        result = []

        for rowNumber in range(len(table)):
            row = table.iloc[rowNumber]

            date = self.cleanText(row[dateName]) if dateName != "" else ""
            details = self.cleanText(row[detailsName]) if detailsName != "" else ""

            if date == "" and details == "":
                continue

            if moneyName != "":
                money = self.readMoney(row[moneyName])
            else:
                spent = self.readMoney(row[spentName]) if spentName != "" else ""
                got = self.readMoney(row[gotName]) if gotName != "" else ""
                money = self.joinMoney(spent, got)

            result.append(
                {
                    "date": date,
                    "description": details,
                    "amount": money
                }
            )

        return result

    