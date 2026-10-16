# 재료 던전 이미지

모든 이미지는 1024 × 1536 PNG, 세로 2:3 비율입니다. 이미지 자체에 UI나 글자를 넣지 않았습니다.

- 공통 던전 3종: growth.png(성장), gold.png(골드), equipment.png(장비)
- 스킬 강화 9속성: skill-{fire,water,wind,earth,lightning,ice,nature,light,dark}.png
- 돌파 9속성: breakthrough-{fire,water,wind,earth,lightning,ice,nature,light,dark}.png
- skill.png와 breakthrough.png는 속성별 이미지 제작의 구도 참조용 원본입니다. 실제 선택 목록은 manifest.json의 21장을 사용합니다.

생성 방식: 내장 image_gen. 공통 5장 신규 생성 후, 스킬 강화·돌파 원본을 참조하여 속성별로 각각 9장 편집 생성했습니다.
공통 이미지의 프롬프트는 generation-prompts.json, 속성별 프롬프트는 generation-prompts-elemental.json에 보관합니다.

MATERIALS 카드에서 던전 목록·층 선택 화면으로 이동합니다. 큰 던전 카드 목록은 마우스 드래그 또는 터치로 좌우 스크롤할 수 있습니다. 스킬 강화·돌파는 한국 시간 자정에 개방 속성이 바뀌며, 평일 1속성·주말 2속성입니다. 개방된 속성별로 카드를 따로 표시하므로 평일에는 5장, 주말에는 7장입니다. 층 선택 화면에는 별도의 속성 선택 버튼이 없습니다. 처음에는 1층만 열리며 이전 층 클리어 시 다음 층이 해금됩니다. 진행도는 던전 종류·속성별로 구분합니다. 실제 전투·보상 지급·에너지 차감은 아직 연결하지 않았습니다.
