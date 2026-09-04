"""Shared loaders for the GPU reporter scripts.

The reporters are standalone stdlib-only scripts (not a package), so the
tests import them by path with importlib.
"""

import importlib.util
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS_DIR / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def reporter():
    return load_module("gpu_reporter", "gpu-reporter.py")


@pytest.fixture()
def reporter_k8s():
    return load_module("gpu_reporter_k8s", "gpu-reporter-k8s.py")
