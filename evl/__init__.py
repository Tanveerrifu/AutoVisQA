"""Evidence Validation Layer (EVL) for screenshot-based visual regression testing.

Implements Algorithm 1 of "When Screenshot Diffing Lies" (IEEE ICCIT 2026):
validate capture pairs and comparison records *before* any threshold decision.
"""
from .core import (Thresholds, Capture, Session, PairVerdict, load_session,
                   validate_sessions, raw_pixel_inequality, sha256_file, normalize_url)

__all__ = ["Thresholds", "Capture", "Session", "PairVerdict", "load_session",
           "validate_sessions", "raw_pixel_inequality", "sha256_file", "normalize_url"]
__version__ = "1.0.0"
