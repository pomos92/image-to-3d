# PyInstaller 설정:  pyinstaller image_to_3d.spec
from PyInstaller.utils.hooks import collect_all, collect_submodules

datas, binaries, hidden = [], [], []
for pkg in ["gradio", "gradio_client", "safehttpx", "groovy", "skimage", "trimesh", "fast_simplification"]:
    try:
        d, b, h = collect_all(pkg)
        datas += d; binaries += b; hidden += h
    except Exception:
        pass
hidden += collect_submodules("scipy.ndimage") + collect_submodules("uvicorn")

a = Analysis(
    ["app.py"],
    datas=datas,
    binaries=binaries,
    hiddenimports=hidden,
    excludes=["torch", "tensorflow", "matplotlib", "IPython", "jupyter", "notebook", "pytest"],
    # gradio 는 소스(.py)를 직접 읽으므로 py 그대로 포함
    module_collection_mode={"gradio": "py", "gradio_client": "py"},
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="ImageTo3D", console=True)
coll = COLLECT(exe, a.binaries, a.datas, name="ImageTo3D")
