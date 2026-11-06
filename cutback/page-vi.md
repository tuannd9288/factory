# Cắt gọn factory (#271, FAC-8): đề xuất để anh duyệt

Đo trên `main` (37ce95a), ngày 06/11. Chưa phần nào bị cắt; chỉ cắt sau khi anh đồng ý. Bảng đủ 49 phần, mỗi phần có lý do và nguồn, ở `cutback/inventory.md`.

## 1. Bỏ: không mục tiêu bản 1 nào cần, không hệ tham chiếu nào làm vậy
- **Lệnh đổi tên team:** chỉ dùng một lần cho #416, việc đó đã xong.
- **Tự dọn worktree sau khi merge:** pstack đã có playbook dọn worktree, Lead chạy khi cần.
- **Cảnh báo lúc mở phiên:** trùng với luồng sự kiện Colly đã nhận. Hai cảnh báo chỉ nó có (digest lỗi, daemon không lên) chuyển sang luồng sự kiện.
- **Gom loại lỗi của reviewer thành issue (#408):** skill `/correct` của pstack đã làm việc này.
- **Kiểm tra repo sau khi nhận vào (doctor):** bước cấp quyền đã tự đọc lại những gì nó đặt, và `verify` xanh trên main là đủ.
- **Bắt mọi check tự chứng minh là fail được, ở mọi PR:** mọi repo trả giá ở từng PR, trong khi test riêng của từng check đã chứng minh việc đó. Đây đúng là "chặn quá đà".
- **Luật tiêu đề commit:** chặn cả commit `wip:` mà bước "Pause safely" của pstack dùng. pstack giữ các commit vào main gọn bằng cách rebase lại trước khi mở PR, đúng cả khi squash lẫn khi merge commit như repo này. Không hệ tham chiếu nào kiểm tiêu đề commit bằng code.
- **Danh sách tấn công làm tay của pack:** không có chương trình probe nào chạy (luật 29–31/10).

## 2. Đã định bỏ từ trước, nay chỉ ghi lại
- **Relay tin của Lead từ Mac mini sang MacBook:** #366 chốt rằng mỗi máy tự chạy, không đi vòng qua máy khác.
- **GitHub Issues làm nơi giao việc** (đánh thức theo comment GitHub, danh sách repo đã sang Linear, lệnh chuyển issue): anh đã nói "Ok, tag rồi gỡ" (04/11); gỡ khi repo cuối cùng sang Linear.
- **Trong lệnh `factory`:** phần gọi GitHub, Linear và đánh thức Lead qua Mac mini (#366).

## 3. Cần anh quyết: đụng quyết định đã chốt, hoặc câu hỏi #271 để anh chọn
- **(a) Module chứng minh PR chỉ xoá code (quyết định 25/10):** sau 12 ngày chưa repo nào bật. Em đề xuất bỏ.
- **(b) Live verifier trên Codex (quyết định 25/10, 30/10):** chưa repo nào được cài, vì chờ #264 từ 30/10. pstack tự chạy verifier trong phiên. Em đề xuất bỏ, dùng cách của pstack.
- **(c) Lớp chặn quyền** (danh sách cấm, sandbox, git riêng cho researcher):
  - piggery chạy worker ở chế độ bypass, chỉ bớt vài công cụ. AO cho bật chế độ bỏ qua quyền. pstack không có luật về việc này.
  - Em đề xuất làm như piggery: giữ một danh sách cấm ngắn (herdr, token), bỏ phần còn lại. Khi đó phần dời cache plugin (#185) và bản sao transcript của Lead cũng có thể bỏ, vì chúng chỉ có vì bị cấm đọc profile.
- **(d) Kết nối Linear chạy liên tục (#414):** option anh chưa chọn, nhưng đã merge và đang chạy. Nó đánh thức Lead khi anh comment trên Linear, việc #375 cần. Em đề xuất giữ, coi như anh đã chọn #414.

## 4. Giữ, và vì sao (nguồn đến từng dòng nằm trong bảng)
- **Mỗi team một tài khoản, Lead pstack, worker, pstack chạy đầy đủ:** mục tiêu của #271 và #185. AO và piggery cũng làm như vậy.
- **Daemon, hàng đợi merge, đánh thức Lead, sự kiện cho Colly, Watcher:** #455, #365, #366, và lời anh 06/11 về Watcher. piggery và seatworks có các phần này.
- **Làm việc trên Linear:** #375. **Nhận repo và cập nhật kit:** luật "mọi repo" (31/10).
- **Cổng merge** (verify, test fail trước, tier, reviewer, anh duyệt, khoá issue): #455 và các quyết định anh đã chốt. pstack và piggery có.
- **Sổ chi phí và digest thứ Hai:** quyết định "lõi mỏng" 22/10, và #366 (d).

## 5. Con số (do `cutback/check.mjs` tính; "dòng code" là `bin/`, `kit/`, `packs/`, `modules/`, không tính test)
| | Trước | Sau mục 1–2 | Thêm (a)(b) | Thêm (c), giữ (d) |
|---|---|---|---|---|
| Phần | 49 | 39 | 37 | 36 |
| Dòng code | 21.789 | 19.890 (−9%) | 18.912 (−13%) | 18.575 (−15%) |
| Test (dòng test) | 1.759 (32.649) | 1.605 (29.668) | 1.500 (27.926) | 1.454 (27.200) |
| Luật có máy kiểm (34 luật hand-in giữ nguyên) | 24 | 22 | 21 | 20 |
| AGENTS.md / section.md (dòng, ước lượng) | 375 / 25 | ~368 / 25 | ~353 / 24 | ~340 / 24 |

Các phần chỉ gọt bớt bên trong (gọi qua Mac mini, đọc GitHub Issues ở 5 phần) chưa được tính.

## 6. Em thấy thêm
- **Phần cắt được nhỏ (9–15%),** vì đa số code đã gắn với mục tiêu bản 1 hoặc quyết định của anh. Ba phần lớn nhất giữ theo quyết định: reviewer (1.268 dòng, 180 test), sổ chi phí (1.074 dòng), luật hand-in (806 dòng).
- **Test nặng hơn code** (32.649 dòng so với 21.789). Riêng khối test reviewer có 1.929 dòng. Bước sau có thể gọt test theo luật "mỗi bất biến một test", hành vi không đổi; chi phí chưa đo.
- **AGENTS.md còn nhắc `bin/brief-check`,** lệnh này đã bị xoá.

**TL;DR**
- **You decide:** yes or no to dropping the 8 parts in section 1, and answers to (a) to (d).
- **Recommendation:** drop the 8 parts, the deletion-proof module and the Codex live verifier; take piggery's short deny list for permissions; keep #414's Linear wake.
- **Risk:** the cuts save 9% of the code, 15% with every recommendation taken, because most parts serve release 1 or your own decisions. The heavier weight is in the tests, a possible next step.
