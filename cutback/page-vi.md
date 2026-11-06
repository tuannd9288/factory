# Cắt gọn factory (#271, FAC-8): đề xuất để anh duyệt

Đo trên `main` (37ce95a), ngày 06/11. Chưa phần nào bị cắt; chỉ cắt sau khi anh đồng ý. Bảng đủ 49 phần, mỗi phần có lý do và nguồn, ở `cutback/inventory.md`.
Em đã đọc đủ 10 hệ tham chiếu, đúng pin của từng hệ, và hai bài SLP của Demonthorn. Năm hệ không có bản sao, hoặc bản sao lệch pin, nên em clone chỉ để đọc. Mọi câu "không hệ nào làm vậy" dưới đây đều dựa trên cả 10 hệ.

## 1. Bỏ: không mục tiêu bản 1 nào cần, không hệ tham chiếu nào làm vậy
- **Lệnh đổi tên team:** chỉ dùng một lần cho #416, việc đó đã xong.
- **Cảnh báo lúc mở phiên:** trùng với luồng sự kiện Colly đã nhận. Hai cảnh báo chỉ nó có (digest lỗi, daemon không lên) chuyển sang luồng sự kiện.
- **Gom loại lỗi của reviewer thành issue (#408):** skill `/correct` của pstack đã làm việc này.
- **Danh sách tấn công làm tay của pack:** không có chương trình probe nào chạy (luật 29–31/10).
- **Gọt: hook chặn commit `wip:` ngay trên máy.** Nó chặn bước "Pause safely" của pstack. Giữ phần CI kiểm tiêu đề mọi commit trong PR, như zeroshot làm.

## 2. Đã định bỏ từ trước, nay chỉ ghi lại
- **Relay tin của Lead từ Mac mini sang MacBook:** #366 chốt rằng mỗi máy tự chạy, không đi vòng qua máy khác.
- **GitHub Issues làm nơi giao việc** (đánh thức theo comment GitHub, danh sách repo đã sang Linear, lệnh chuyển issue): anh đã nói "Ok, tag rồi gỡ" (04/11); gỡ khi repo cuối cùng sang Linear.
- **Trong lệnh `factory`:** phần gọi GitHub, Linear và đánh thức Lead qua Mac mini (#366).

## 3. Cần anh quyết: đụng quyết định đã chốt, đụng cổng merge, hoặc câu hỏi #271 để anh chọn
- **(a) Module chứng minh PR chỉ xoá code (quyết định 25/10):** sau 12 ngày chưa repo nào bật. Em đề xuất bỏ.
- **(b) Live verifier trên Codex (quyết định 25/10, 30/10):** chưa repo nào được cài, vì chờ #264 từ 30/10. pstack tự chạy verifier trong phiên. Em đề xuất bỏ, dùng cách của pstack.
- **(c) Lớp chặn quyền** (sandbox, cấm đọc thư mục chứa khoá, git riêng cho researcher):
  - Nếu bỏ, mọi seat và Lead đọc được khoá SSH và mọi token đã lưu (`~/.ssh`, `~/.agent-profiles`, `~/.claude`, `~/.config`).
  - Các hệ tham chiếu chia đôi:
    - seatworks có danh sách cấm và sandbox cho từng seat, giống factory, kể cả git đi qua một lớp kiểm. AO và zeroshot tôn trọng sandbox nếu có cài.
    - zeroshot (khi chạy trên cloud) và warp chạy agent trong container. pi-herdsman chỉ giới hạn công cụ.
    - piggery, dsh và paperclip bỏ chặn và chạy thẳng bằng user của máy. Chính team này đang tạm chạy dưới chế độ bypass của piggery, và supervisor đã cảnh báo việc đó trên #375, nên đây là tiền lệ yếu để giữ lâu.
    - pstack, paseo-slp và Demonthorn không có luật về việc này.
  - Em đề xuất giữ lớp này.
- **(d) Kết nối Linear chạy liên tục (#414):** em đề xuất anh chọn #414, vì nó đánh thức Lead khi anh comment trên Linear, việc #375 cần.
- **(e) Bắt mọi check tự chứng minh là fail được, ở mọi PR:** nó canh rằng một check hỏng không lọt qua, nhưng mọi repo trả giá ở từng PR. Không hệ nào làm vậy; test riêng của từng check đã chứng minh việc đó. Bỏ thì `verify` thôi gọi nó và mất một luật của cổng. Em đề xuất bỏ.
- **(f) Kiểm tra repo sau khi nhận vào (doctor):** nó canh bước nhận repo; issue "Take <repo> in" chỉ đóng khi mọi dòng xanh. piggery (`check`), paperclip (`doctor`) và seatworks đều có lệnh tương tự, nên em rút đề xuất bỏ: giữ.

## 4. Giữ, và vì sao (nguồn đến từng dòng nằm trong bảng)
- **Mỗi team một tài khoản, Lead pstack, worker, pstack chạy đầy đủ:** mục tiêu của #271 và #185. AO và piggery cũng làm như vậy.
- **Daemon, hàng đợi merge, đánh thức Lead, sự kiện cho Colly, Watcher, tự dọn worktree:** #455, #365, #366, và lời anh 06/11 về Watcher. piggery, seatworks và AO có các phần này.
- **Làm việc trên Linear:** #375. **Nhận repo và cập nhật kit:** luật "mọi repo" (31/10).
- **Cổng merge** (verify, test fail trước, tier, reviewer, anh duyệt, khoá issue, tiêu đề commit trên CI): #455 và các quyết định anh đã chốt. pstack, piggery và zeroshot có.
- **Sổ chi phí và digest thứ Hai:** quyết định "lõi mỏng" 22/10, và #366 (d).

## 5. Con số (do `cutback/check.mjs` tính; "dòng code" là `bin/`, `kit/`, `packs/`, `modules/`, không tính test)
| | Trước | Sau mục 1–2 | Thêm (a)(b)(e), theo đề xuất | Nếu bỏ cả (c) |
|---|---|---|---|---|
| Phần | 49 | 43 | 40 | 39 |
| Dòng code | 21.789 | 20.547 (−6%) | 19.405 (−11%) | 19.068 (−12%) |
| Test (dòng test) | 1.759 (32.649) | 1.654 (30.563) | 1.549 (28.821) | 1.503 (28.095) |
| Luật có máy kiểm (34 luật hand-in giữ nguyên) | 24 | 24 | 22 | 21 |
| AGENTS.md / section.md (dòng, ước lượng) | 375 / 25 | ~370 / 25 | ~355 / 24 | ~342 / 24 |

Các phần chỉ gọt bớt bên trong (gọi qua Mac mini, đọc GitHub Issues ở 5 phần, hook `wip:`) chưa được tính.

## 6. Em thấy thêm
- **Phần cắt được nhỏ (6–11%),** vì đa số code gắn với mục tiêu bản 1, với quyết định của anh, hoặc có hệ tham chiếu làm y vậy. So đủ 10 hệ, em rút ba đề xuất bỏ vì có hệ khác cũng làm: tự dọn worktree, doctor, kiểm tiêu đề commit trên CI.
- **Ba phần lớn nhất giữ theo quyết định:** reviewer (1.268 dòng, 180 test), sổ chi phí (1.074 dòng), luật hand-in (806 dòng).
- **Test nặng hơn code** (32.649 dòng so với 21.789). Riêng khối test reviewer có 1.929 dòng. Bước sau có thể gọt test theo luật "mỗi bất biến một test", hành vi không đổi; chi phí chưa đo.
- **AGENTS.md còn nhắc `bin/brief-check`,** lệnh này đã bị xoá.

**TL;DR**
- **You decide:** yes or no to the 4 cuts and the hook trim in section 1, and answers to (a) to (f).
- **Recommendation:** drop the deletion-proof module, the Codex live verifier and the "every check fails on a fixture" proof; keep the permission layer and the doctor; pick #414.
- **Risk:**
  - The cuts save 6% of the code, 11% with every recommendation taken, because most parts serve release 1, your decisions, or what a reference does.
  - Dropping (c) would let every seat and Lead read the SSH keys and every stored token.
