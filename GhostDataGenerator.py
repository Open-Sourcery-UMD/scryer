import csv
import random
from datetime import datetime, timedelta
from faker import Faker

fake = Faker()
Faker.seed(42)
random.seed(42)

outputFile = "mock_data.csv"

endDate = datetime.today().date()
startDate = endDate - timedelta(days=180)

initialBalance = round(random.uniform(2500, 12000), 2)
runningBalance = initialBalance

netflixPlans = [6.99, 15.49, 22.99]
spotifyPlans = [0.00, 5.99, 11.99, 16.99]
internetBill = round(random.uniform(45, 95), 2)
phoneBill = round(random.uniform(35, 90), 2)
rentAmount = round(random.uniform(1200, 3200), 2)

fixedMonthlyCosts = {
    "Rent": rentAmount,
    "Internet": internetBill,
    "PhoneBill": phoneBill,
    "Netflix": random.choice(netflixPlans),
    "Spotify": random.choice(spotifyPlans),
}

vehicleType = random.choice(["Gas", "Electric"])

fuelDescription = "Gas Station" if vehicleType == "Gas" else "EV Charging"

fuelRanges = {
    "Gas": (28, 75),
    "Electric": (10, 30),
}

groceryStores = ["Trader Joe's", "Whole Foods", "Costco", "Walmart", "Target", "Aldi", "Safeway", "ShopRite", "Local Farmers Market"]

coffeeShops = ["Starbucks", "Dunkin", "Local Cafe"]

restaurants = ["Chipotle", "Panera", "Sweetgreen", "Cava", "Subway", "Shake Shack", "Local Restaurant"]

shoppingStores = ["Amazon", "Target", "Best Buy", "Macy's", "CVS", "Walgreens", "Shopping Mall"]

gasStations = ["Shell", "Exxon", "BP", "Sunoco", "Wawa", "Costco Gas", "Service Area"]

evChargingVendors = ["Tesla Supercharger", "Rivian Adventure Network," "Ionna", "ChargePoint", "EVgo", "Electrify America", "Mercedes HyperPower", "Home Charging"]

entertainmentVendors = ["AMC Theatres", "Spotify Event Ticket", "Apple", "Steam", "GameStop"]

payFrequency = random.choice(["biweekly", "monthly"])
basePaycheck = round(random.uniform(2200, 5500), 2)

currentDate = startDate
while currentDate.weekday() != 4:
    currentDate += timedelta(days=1)

firstPaycheckDate = currentDate
if payFrequency == "monthly":
    firstPaycheckDate = startDate + timedelta(days=random.randint(0, 20))


def addTransaction(rows, dateObj, category, description, amount):
    rows.append({
        "date": dateObj,
        "category": category,
        "description": description,
        "amount": round(amount, 2)
    })


def isPayday(dateObj):
    if payFrequency == "biweekly":
        deltaDays = (dateObj - firstPaycheckDate).days
        return deltaDays >= 0 and deltaDays % 14 == 0
    else:
        payDay = min(firstPaycheckDate.day, 28)
        return dateObj.day == payDay


def randomMerchant(categoryName):
    if categoryName == "Groceries":
        return random.choice(groceryStores)
    if categoryName == "Coffee":
        return random.choice(coffeeShops)
    if categoryName == "Dining":
        return random.choice(restaurants)
    if categoryName == "Shopping":
        return random.choice(shoppingStores)
    if categoryName == fuelDescription:
        return random.choice(gasStations if vehicleType == "Gas" else evChargingVendors)
    if categoryName == "Entertainment":
        return random.choice(entertainmentVendors)
    return fake.company()


rows = []

currentDate = startDate

while currentDate <= endDate:

    if isPayday(currentDate):
        paycheckVariance = random.uniform(-250, 400)
        amount = max(1500, round(basePaycheck + paycheckVariance, 2))
        employer = f"{fake.company()} Payroll"
        addTransaction(rows, currentDate, "Income", employer, amount)

    if currentDate.day == 1:
        addTransaction(rows, currentDate, "Housing", "Rent", -fixedMonthlyCosts["Rent"])

    if currentDate.day == 3:
        addTransaction(rows, currentDate, "Utilities", "Internet", -fixedMonthlyCosts["Internet"])

    if currentDate.day == 5:
        addTransaction(rows, currentDate, "Utilities", "Phone Bill", -fixedMonthlyCosts["PhoneBill"])

    if currentDate.day == 8 and fixedMonthlyCosts["Netflix"] > 0:
        addTransaction(rows, currentDate, "Subscription", "Netflix", -fixedMonthlyCosts["Netflix"])

    if currentDate.day == 10 and fixedMonthlyCosts["Spotify"] > 0:
        addTransaction(rows, currentDate, "Subscription", "Spotify", -fixedMonthlyCosts["Spotify"])

    groceryChance = 0.22 if currentDate.weekday() < 5 else 0.30
    if random.random() < groceryChance:
        amount = -round(random.uniform(35, 165), 2)
        desc = f"Groceries - {randomMerchant('Groceries')}"
        addTransaction(rows, currentDate, "Food", desc, amount)

    coffeeChance = 0.35 if currentDate.weekday() < 5 else 0.12
    if random.random() < coffeeChance:
        amount = -round(random.uniform(3.50, 9.75), 2)
        desc = f"Coffee - {randomMerchant('Coffee')}"
        addTransaction(rows, currentDate, "Food", desc, amount)

    diningChance = 0.12 if currentDate.weekday() < 5 else 0.28
    if random.random() < diningChance:
        amount = -round(random.uniform(12, 65), 2)
        desc = f"Dining - {randomMerchant('Dining')}"
        addTransaction(rows, currentDate, "Food", desc, amount)

    fuelChance = 0.08 if vehicleType == "Gas" else 0.10
    if random.random() < fuelChance:
        low, high = fuelRanges[vehicleType]
        amount = -round(random.uniform(low, high), 2)
        desc = f"{fuelDescription} - {randomMerchant(fuelDescription)}"
        addTransaction(rows, currentDate, "Transport", desc, amount)

    if random.random() < 0.07:
        amount = -round(random.uniform(15, 180), 2)
        desc = f"Shopping - {randomMerchant('Shopping')}"
        addTransaction(rows, currentDate, "Shopping", desc, amount)

    if random.random() < 0.05:
        amount = -round(random.uniform(8, 90), 2)
        desc = f"Entertainment - {randomMerchant('Entertainment')}"
        addTransaction(rows, currentDate, "Entertainment", desc, amount)

    randomEvent = random.random()
    if randomEvent < 0.02:
        amount = -round(random.uniform(1, 15), 2)
        addTransaction(rows, currentDate, "Banking", "ATM Fee / Service Fee", amount)
    elif randomEvent < 0.035:
        amount = round(random.uniform(5, 40), 2)
        addTransaction(rows, currentDate, "Refund", f"Refund - {fake.company()}", amount)

    currentDate += timedelta(days=1)

rows.sort(key=lambda x: x["date"])

finalRows = []

for row in rows:
    runningBalance += row["amount"]
    finalRows.append([
        row["date"].strftime("%Y-%m-%d"),
        row["category"],
        row["description"],
        round(row["amount"], 2),
        round(runningBalance, 2)
    ])

with open(outputFile, mode="w", newline="", encoding="utf-8") as file:
    writer = csv.writer(file)
    writer.writerow(["date", "category", "description", "amount", "balance"])
    writer.writerows(finalRows)

print(f"Mock data written to {outputFile}")