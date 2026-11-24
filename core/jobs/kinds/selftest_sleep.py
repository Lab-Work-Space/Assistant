import time


def run(payload, progress):
    time.sleep(float(payload.get("seconds", 1)))
    return {"slept": True}
