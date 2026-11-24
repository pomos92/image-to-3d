"""웹 화면 실행:  python app.py  →  브라우저에서 http://127.0.0.1:7860 열기"""
import os
import sys

os.environ.setdefault("GRADIO_ANALYTICS_ENABLED", "False")
if getattr(sys, "frozen", False):  # exe 로 실행 중이면 결과 폴더를 exe 옆에 만든다
    os.chdir(os.path.dirname(sys.executable))

import gradio as gr

import img23d  # noqa: F401  (콘솔 인코딩 설정)
from img23d import generate

ENGINES = {
    "자동 (AI 먼저, 안 되면 오프라인)": "auto",
    "클라우드 AI만 (인터넷 필요, 고품질)": "cloud",
    "오프라인 기본 (빠름, 인터넷 불필요)": "basic",
}


def run(image, engine_label, cloud_model, token, remove_bg, thickness, resolution, size_mm, progress=gr.Progress()):
    if image is None:
        raise gr.Error("이미지를 먼저 넣어 주세요.")
    steps = []

    def log(m):
        steps.append(m)
        progress(None, desc=m)

    try:
        r = generate(
            image,
            engine=ENGINES[engine_label],
            cloud_model=cloud_model,
            hf_token=(token or "").strip() or None,
            remove_bg=remove_bg,
            thickness=thickness,
            resolution=int(resolution),
            size_mm=size_mm,
            log=log,
        )
    except Exception as e:
        raise gr.Error(f"생성 실패: {e}")
    status = f"사용한 엔진: {r.engine}\n\n" + "\n".join(steps)
    return r.glb, [r.glb, r.obj_zip, r.stl], status


with gr.Blocks(title="이미지 → 3D 생성기") as demo:
    gr.Markdown("## 이미지 → 3D 생성기\n사진 한 장을 넣으면 보이지 않는 뒷면까지 추정해 3D 모델을 만들고 GLB / OBJ / STL 파일로 저장합니다.")
    with gr.Row():
        with gr.Column():
            image = gr.Image(type="pil", label="입력 이미지 (배경이 단순할수록 좋아요)", image_mode="RGBA")
            engine = gr.Radio(list(ENGINES), value=list(ENGINES)[0], label="엔진")
            with gr.Accordion("고급 설정", open=False):
                cloud_model = gr.Dropdown(["자동", "TRELLIS", "Hunyuan3D-2", "TripoSR"], value="자동", label="클라우드 AI 모델")
                token = gr.Textbox(label="Hugging Face 토큰 (선택, 사용 한도 늘리기)", type="password")
                remove_bg = gr.Checkbox(True, label="배경 자동 제거 (오프라인 엔진)")
                thickness = gr.Slider(0.1, 1.0, 0.5, step=0.05, label="두께 (오프라인 엔진)")
                resolution = gr.Slider(64, 256, 160, step=16, label="해상도 (오프라인 엔진)")
                size_mm = gr.Number(100, label="STL 크기 (가장 긴 변, mm)")
            btn = gr.Button("3D 만들기", variant="primary")
        with gr.Column():
            viewer = gr.Model3D(label="3D 미리보기 (마우스로 돌려보기)")
            files = gr.File(label="다운로드 (GLB: 범용·색상 포함 / OBJ: 편집툴용 / STL: 3D 프린팅용)", file_count="multiple")
            status = gr.Textbox(label="진행 기록", lines=6)
    btn.click(run, [image, engine, cloud_model, token, remove_bg, thickness, resolution, size_mm], [viewer, files, status])

if __name__ == "__main__":
    print("이미지 → 3D 생성기를 시작합니다. 잠시 후 브라우저가 열려요.")
    print("이 검은 창을 닫으면 프로그램이 종료됩니다.")
    demo.queue().launch(inbrowser=True)
