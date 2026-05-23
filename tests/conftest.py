import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


@pytest.fixture
def client():
    from app import app

    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


@pytest.fixture
def fidelity_history_text():
    path = os.path.join(FIXTURES, "fidelity_history.csv")
    with open(path, encoding="utf-8") as f:
        return f.read()


@pytest.fixture
def ibkr_history_text():
    path = os.path.join(FIXTURES, "ibkr_history.csv")
    with open(path, encoding="utf-8") as f:
        return f.read()


@pytest.fixture
def schwab_history_text():
    path = os.path.join(FIXTURES, "schwab_history.csv")
    with open(path, encoding="utf-8") as f:
        return f.read()
