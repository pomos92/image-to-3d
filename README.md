# 이미지 → 3D 생성기

사진 한 장을 넣으면 **보이지 않는 뒷면까지 추정해서** 3D 모델을 만들고 파일로 저장해 주는 프로그램입니다.

- **GLB**: 색/텍스처 포함. 윈도우 "3D 뷰어", 블렌더, 웹, 게임엔진 등 어디서나 열림
- **OBJ (zip)**: 블렌더·마야 등 편집 툴용
- **STL**: 3D 프린팅용 (가장 긴 변을 원하는 mm 크기로 맞춰 저장, 바닥이 평평하게 놓이도록 정렬)

## 엔진 2가지

| 엔진 | 품질 | 필요한 것 | 특징 |
|---|---|---|---|
| **클라우드 AI** | 높음 | 인터넷 | Hugging Face 의 무료 공개 AI(TRELLIS → Hunyuan3D-2 → TripoSR 순서로 시도). GPU 필요 없음. 공개 서버라 대기열/사용량 제한이 있을 수 있음 |
| **오프라인 기본** | 보통 | 없음 | 실루엣을 부풀리고 뒷면은 앞면과 대칭이라고 가정. 1~3초. 캐릭터·인형·과일·로고처럼 둥근 물체에 잘 맞음 |

기본값 "자동"은 클라우드 AI를 먼저 쓰고, 안 되면 오프라인 엔진으로 자동 전환합니다.

## 윈도우 exe 버전 (Python 설치 필요 없음)

1. `ImageTo3D-windows.zip` 을 받아서 압축을 풉니다.
2. `ImageTo3D` 폴더 안의 **`ImageTo3D.exe`** 를 더블클릭합니다.
3. 검은 창이 뜨고 잠시 후(10~30초) 브라우저에 화면이 열립니다. 결과 파일은 exe 옆 `outputs` 폴더에 저장됩니다.
   검은 창을 닫으면 프로그램이 종료됩니다.

- 처음 실행할 때 윈도우가 "PC 보호" 경고를 띄우면 **추가 정보 → 실행** 을 누르세요 (서명되지 않은 프로그램이라 뜨는 경고).
- exe 는 GitHub Actions(`.github/workflows/build-windows.yml`)가 윈도우 서버에서 자동으로 만듭니다. 직접 만들려면 `pip install pyinstaller` 후 `pyinstaller image_to_3d.spec`.

## 설치 (처음 한 번, Python 으로 실행할 때)

1. [Python 3.10 이상](https://www.python.org/downloads/) 설치 (윈도우는 설치 화면에서 **"Add python.exe to PATH" 체크**)
2. 이 폴더에서 실행:
   - **윈도우**: `실행_windows.bat` 더블클릭
   - **맥/리눅스**: 터미널에서 `sh run_mac_linux.sh`

처음 실행할 때 필요한 라이브러리를 자동 설치하고(몇 분), 브라우저에 `http://127.0.0.1:7860` 화면이 열립니다.

수동 설치를 원하면:
```bash
python -m venv .venv
# 윈도우: .venv\Scripts\activate   /  맥·리눅스: source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

## 사용법

1. 이미지를 끌어다 놓기 (배경이 단순하거나, 배경을 지운 PNG일수록 결과가 좋음)
2. **3D 만들기** 클릭
3. 오른쪽에서 3D를 마우스로 돌려보고, 아래에서 GLB / OBJ / STL 다운로드
   (파일은 `outputs` 폴더에도 저장됨)

명령줄로도 쓸 수 있습니다:
```bash
python cli.py 사진.jpg                       # 자동
python cli.py 사진.jpg --engine basic        # 오프라인만
python cli.py 사진.jpg --engine cloud --model TRELLIS --size-mm 80
```

## 팁

- **클라우드 사용 한도**: [Hugging Face](https://huggingface.co) 무료 가입 → Settings → Access Tokens 에서 토큰(Read) 발급 → 화면의 "고급 설정"에 붙여넣기 (또는 환경변수 `HF_TOKEN`). 무료 GPU 사용 한도가 늘어납니다.
- 오프라인 엔진의 **두께** 슬라이더: 0.5 = 동그란 단면, 낮추면 납작(배지·쿠키), 높이면 통통.
- 오프라인 엔진의 배경 제거를 더 잘 하려면 `pip install "rembg[cpu]"` (선택).
- 클라우드 AI가 계속 실패하면 해당 공개 서버가 꺼졌거나 바뀐 것일 수 있습니다. "고급 설정"에서 다른 모델을 골라 보세요.

## 구조

```
app.py              웹 화면 (Gradio)
cli.py              명령줄 버전
img23d/
  pipeline.py       엔진 선택 → 3D 생성 → GLB/OBJ/STL 저장
  cloud.py          Hugging Face 공개 AI 호출 (TRELLIS / Hunyuan3D-2 / TripoSR)
  basic.py          오프라인 엔진 (배경 제거 → 실루엣 '구 합치기' 부풀리기 → 마칭 큐브)
```
