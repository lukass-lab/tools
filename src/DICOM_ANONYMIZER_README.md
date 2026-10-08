# DICOM CLI — disabled

The legacy DICOM anonymizer is disabled. It could leave identifiers in output files and copy UID-named DICOM files unchanged. It must not be used for de-identification.

Running `python src/dicom_anonymizer.py` exits with status 1 and a clear message on standard error. This also applies to `--help`, default invocation and explicit input/output arguments. The stub requires only Python's standard library and never reads input files or creates output files.

The previous implementation remains available in Git history for reference. Restoring it does not resolve these defects.

Run the containment regression test from the repository root:

```bash
python -B -m unittest discover -s tests -p "test_*.py"
```

A replacement requires validated de-identification behavior and tests before processing is re-enabled.
