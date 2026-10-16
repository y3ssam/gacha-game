# 재료 던전 이미지

모든 이미지는 1024 × 1536 PNG, 세로 2:3 비율입니다. 이미지 자체에 UI나 글자를 넣지 않았습니다.

- 공통 던전 3종: growth.png(성장), gold.png(골드), equipment.png(장비)
- 스킬 강화 9속성: skill-{fire,water,wind,earth,lightning,ice,nature,light,dark}.png
- 돌파 9속성: breakthrough-{fire,water,wind,earth,lightning,ice,nature,light,dark}.png
- skill.png와 breakthrough.png는 속성별 이미지 제작의 구도 참조용 원본입니다. 실제 선택 목록은 manifest.json의 21장을 사용합니다.

생성 방식: 내장 image_gen. 공통 5장 신규 생성 후, 스킬 강화·돌파 원본을 참조하여 속성별로 각각 9장 편집 생성했습니다.
공통 이미지의 프롬프트는 generation-prompts.json, 속성별 프롬프트는 generation-prompts-elemental.json에 보관합니다.

이번 작업은 이미지 에셋 제작입니다. 던전 화면과 한국 시간 자정 기준의 속성 변경 기능은 아직 연결하지 않았습니다.
