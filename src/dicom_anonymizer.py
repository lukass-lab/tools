#!/usr/bin/env python3
"""Disabled legacy DICOM CLI. The previous implementation remains in Git history."""

import sys

DISABLED_MESSAGE = (
    "DICOM anonymization is disabled: the legacy implementation can leave patient "
    "identifiers intact and copy DICOM files without processing them. "
    "No files were read or written. Do not use this tool for de-identification."
)


def main():
    print(DISABLED_MESSAGE, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
