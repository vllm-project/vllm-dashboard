"""Load the YAML configuration bundled in triage/config/."""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

import yaml

CONFIG_DIR = Path(__file__).resolve().parent / "config"


def _load(name: str, config_dir: Path | None = None) -> dict[str, Any]:
    path = (config_dir or CONFIG_DIR) / name
    data = yaml.safe_load(path.read_text())
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected a mapping at the top level")
    return data


@dataclass(frozen=True)
class AreaRules:
    paths: tuple[tuple[str, re.Pattern[str]], ...]
    labels: dict[str, str]

    def areas_for_path(self, path: str) -> set[str]:
        return {area for area, pattern in self.paths if pattern.search(path)}


@dataclass(frozen=True)
class TriageConfig:
    areas: AreaRules
    scoring: dict[str, Any]
    tiers: dict[str, Any]

    @property
    def version(self) -> str:
        return f"{self.scoring['version']}+tiers.{self.tiers['version']}"


def load_config(config_dir: Path | None = None) -> TriageConfig:
    raw_areas = _load("areas.yaml", config_dir)
    compiled = tuple(
        (area, re.compile(pattern))
        for area, patterns in raw_areas["areas"].items()
        for pattern in patterns
    )
    return TriageConfig(
        areas=AreaRules(paths=compiled, labels=dict(raw_areas.get("labels", {}))),
        scoring=_load("scoring.yaml", config_dir),
        tiers=_load("tiers.yaml", config_dir),
    )


@cache
def default_config() -> TriageConfig:
    return load_config()
