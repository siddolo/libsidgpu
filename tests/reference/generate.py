import pathlib
import subprocess
import sys

source = pathlib.Path(sys.argv[1]).resolve()
here = pathlib.Path(__file__).resolve().parent
config = (source / "siddefs.h.in").read_text()
for name, value in {
    "RESID_INLINING": "1", "RESID_INLINE": "inline", "RESID_BRANCH_HINTS": "0",
    "NEW_8580_FILTER": "1", "HAVE_BOOL": "1", "HAVE_BUILTIN_EXPECT": "1", "HAVE_LOG1P": "1",
}.items():
    config = config.replace(f"@{name}@", value)
(source / "siddefs.h").write_text(config)
for data in source.glob("wave*.dat"):
    subprocess.run(["perl", str(source / "samp2src.pl"), data.stem, str(data), str(data.with_suffix(".h"))], check=True)
files = ["sid", "voice", "wave", "envelope", "filter8580new", "dac", "extfilt", "pot"]
binary = source / "sidgpu-resid-probe"
subprocess.run(["c++", "-std=c++11", "-O2", "-I", str(source), str(here / "resid-probe.cc"),
                *[str(source / f"{name}.cc") for name in files], "-o", str(binary)], check=True)
result = subprocess.check_output([str(binary)], text=True)
(here / "resid-digital.json").write_text(result)
print(subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip())
print(result)
