from __future__ import annotations

import re
from typing import Any
import shutil

import cv2
import numpy as np

YELLOW_PATTERNS = [
    re.compile(r"\bYELLOW\s+FLAG\b", re.IGNORECASE),
]
SAFETY_CAR_PATTERNS = [
    re.compile(r"\bSAFETY\s+CAR\b", re.IGNORECASE),
    re.compile(r"\bVIRTUAL\s+SAFETY\s+CAR\b", re.IGNORECASE),
]
SAFETY_CAR_ENDING_PATTERNS = [
    re.compile(r"\bSAFETY\s+CAR\s+ENDING\b", re.IGNORECASE),
    re.compile(r"\bSAFETY\s*CAR\b.*\bENDING\b", re.IGNORECASE),
    re.compile(r"\bENDING\b.*\bSAFETY\s*CAR\b", re.IGNORECASE),
]
LAP_PATTERNS = [
    re.compile(r"\bLAP\s*(\d{1,3})\s*/\s*\d{1,3}\b", re.IGNORECASE),
    re.compile(r"\bLAP\s*(\d{1,3})\b", re.IGNORECASE),
]


class OcrReader:
    def __init__(self) -> None:
        self._reader: Any | None = None
        self._mode = "none"
        self._tesseract_config = "--oem 1 --psm 6 -l eng"

        # Prefer Tesseract for speed/stability in this OCR-only pipeline.
        try:
            if shutil.which("tesseract"):
                import pytesseract  # type: ignore

                self._reader = pytesseract
                self._mode = "tesseract"
                return
        except Exception:
            pass

        # Fallback to EasyOCR only when Tesseract is unavailable.
        try:
            import easyocr  # type: ignore

            self._reader = easyocr.Reader(
                ["en"],
                gpu=False,
                verbose=False,
                model_storage_directory="/tmp/easyocr-models",
                user_network_directory="/tmp/easyocr-user",
            )
            self._mode = "easyocr"
        except Exception:
            self._reader = None
            self._mode = "none"

    @property
    def mode(self) -> str:
        return self._mode

    def read_text(self, image_bgr: np.ndarray) -> str:
        if self._reader is None:
            return ""

        # Grayscale + binary thresholding gives faster and cleaner OCR input.
        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
        gray = cv2.medianBlur(gray, 3)
        gray = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]

        if self._mode == "tesseract":
            try:
                text = self._reader.image_to_string(gray, config=self._tesseract_config)
            except Exception:
                return ""
            return text

        if self._mode == "easyocr":
            try:
                results = self._reader.readtext(gray, detail=0, paragraph=False)
            except Exception:
                return ""
            return " ".join(results)

        return ""


class YellowFlagDetector:
    def __init__(self, ocr: OcrReader, roi_top_ratio: float, roi_bottom_ratio: float, roi_right_ratio: float = 1.0) -> None:
        self.ocr = ocr
        self.roi_top_ratio = roi_top_ratio
        self.roi_bottom_ratio = roi_bottom_ratio
        self.roi_right_ratio = roi_right_ratio

    def _top_roi(self, frame_bgr: np.ndarray) -> np.ndarray:
        height, width = frame_bgr.shape[0], frame_bgr.shape[1]
        y1 = int(height * self.roi_top_ratio)
        y2 = int(height * self.roi_bottom_ratio)
        x2 = max(1, int(width * self.roi_right_ratio))
        return frame_bgr[y1:y2, :x2]

    def detect_yellow_flag(self, frame_bgr: np.ndarray) -> tuple[bool, float, str]:
        roi = self._top_roi(frame_bgr)
        text = self.ocr.read_text(roi)
        matched = any(p.search(text) for p in YELLOW_PATTERNS)
        confidence = 0.9 if matched else 0.0
        return matched, confidence, text

    def detect_safety_car(self, frame_bgr: np.ndarray) -> tuple[bool, float, str]:
        roi = self._top_roi(frame_bgr)
        text = self.ocr.read_text(roi)
        matched = any(p.search(text) for p in SAFETY_CAR_PATTERNS)
        confidence = 0.9 if matched else 0.0
        return matched, confidence, text

    def detect_safety_car_ending(self, frame_bgr: np.ndarray) -> tuple[bool, float, str]:
        roi = self._top_roi(frame_bgr)
        text = self.ocr.read_text(roi)
        matched = any(p.search(text) for p in SAFETY_CAR_ENDING_PATTERNS)
        if not matched:
            # OCR commonly merges spacing/punctuation, so normalize and check key tokens.
            normalized = re.sub(r"[^A-Z]", "", text.upper())
            has_safety_car = "SAFETYCAR" in normalized or "VIRTUALSAFETYCAR" in normalized
            has_ending = "ENDING" in normalized
            matched = has_safety_car and has_ending
        confidence = 0.9 if matched else 0.0
        return matched, confidence, text

    def parse_lap(self, text: str) -> int | None:
        for pattern in LAP_PATTERNS:
            match = pattern.search(text)
            if not match:
                continue
            try:
                return int(match.group(1))
            except Exception:
                continue
        return None
