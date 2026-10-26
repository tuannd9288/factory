> Colly gửi Lead factory. Anh Tuấn yêu cầu: thiết kế lại #71 theo https://agentskills.io/home để có thiết kế đúng. Câu hỏi về phương án giữa ở tin trước gộp vào việc này.
>
> Điều anh lo: khi tính năng tắt, agent vẫn phải nạp luật của nó.
> - Hôm nay agent nạp AGENTS.md ở mọi phiên, vì `kit/CLAUDE.md` = `@AGENTS.md`. Nhánh #17 thêm vào đó khoảng 10 dòng (+14/−7).
> - Agent Skills giải đúng việc này bằng progressive disclosure. Lúc khởi phiên chỉ nạp `name` và `description` (khoảng 50–100 token mỗi skill). Phần thân `SKILL.md` chỉ nạp khi việc khớp với description. `scripts/` và `references/` chỉ nạp khi cần (specification.md, mục "Progressive disclosure").
>
> Tau đọc nhanh thì thấy #71 gồm hai phần khác nhau. Bạn xác minh hoặc bác:
> - **(a) Phần cổng chặn:** `red-check` và `deletion.mjs`. Chúng chạy trong CI, lấy bản của `main`, và không nằm trong ngữ cảnh của agent. Skill không thay được phần này, vì cổng không được phụ thuộc vào việc agent có nạp skill hay không. Khi tắt, nó dừng ngay ở bước kiểm `knip.json` đầu tiên.
> - **(b) Phần hướng dẫn agent:** khoảng 10 dòng AGENTS.md, cộng cách làm một PR xoá bằng `knip --fix` ở base. Phần này đúng là một skill, ví dụ `deletion-proof`, và có thể kèm `scripts/` cho agent tự chạy `knip --fix`.
> - Nếu đúng vậy, cơ chế module nặng có thể không cần nữa: không ghép AGENTS.md, không chép module. Câu hỏi còn lại chỉ là skill đến repo bằng đường nào:
>   - chép vào `.claude/skills/` hoặc `.agents/skills/` của repo, và `kit-evidence` chứng minh file đó;
>   - hoặc một plugin ghim theo SHA như pstack, đi qua `settings.json` mà `kit-evidence` đã chứng minh được, nhưng mỗi repo và profile cần anh cài một lần (tốn G1).
>
> Theo luật "no half adoption":
> - Đọc hết 9 trang trong https://agentskills.io/llms.txt (tau đã tải sẵn 4 trang ở MacBook, nhưng ghế `factory` nên tự đọc bằng WebFetch).
> - Đọc trang skills của Claude Code (code.claude.com/docs/en/skills).
> - Trả lời được những câu sau:
>   - Claude Code tìm skill cấp project ở đâu: `.claude/skills/`, hay có cả `.agents/skills/`?
>   - Phiên `claude -p` của thợ và của reviewer có nạp skill không?
>   - Description viết thế nào để skill kích hoạt đúng lúc PR chỉ xoá?
>   - Luật "không skill cấp user" của xưởng có bị chạm không?
>
> Đầu ra:
> - Thiết kế mới cho #71, kèm thay đổi ở #72 và #73 nếu có.
> - Ước giá so với 220–290 dòng của cơ chế cũ, và rủi ro, nhất là ở `kit-evidence`.
> - Một câu: off thì agent tốn bao nhiêu token, on thì tốn bao nhiêu.
> - Sửa thân các issue thì cứ làm, vì việc đó đảo ngược được.
>
> Vẫn chưa giao builder. Xong thì báo tau, tau đưa anh chọn.
