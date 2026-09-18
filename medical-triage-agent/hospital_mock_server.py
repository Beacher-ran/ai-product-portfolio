# -*- coding: utf-8 -*-
"""
医院业务查询 Mock 服务
供 Dify「医疗 AI-Workflow Demo」中的 HTTP 工具调用节点使用。

启动：  python hospital_mock_server.py
地址：  http://localhost:18080/api/hospital/service
（Dify 容器通过 http://host.docker.internal:18080 访问本服务）
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 18080

# ---------------- 业务规则库 ----------------
SERVICES = [
    {
        "key": "registration",
        "keywords": ["挂号", "预约", "号源", "挂哪个", "门诊时间", "什么时候上班", "几点"],
        "text": (
            "【预约挂号】\n"
            "线上渠道：\n"
            "  1. 医院官方微信公众号 → 就医服务 → 预约挂号（可提前 7 天）\n"
            "  2. 医院官方 APP → 门诊 → 预约挂号\n"
            "  3. 电话预约：96120（工作日 8:00-17:30）\n"
            "线下渠道：门诊一楼自助机、人工窗口（工作日 7:30-17:00）\n\n"
            "就诊提示：\n"
            "  · 首次就诊请携带身份证，先到一楼大厅办理就诊卡或激活电子健康卡\n"
            "  · 建议提前 30 分钟到院取号\n"
            "  · 迟到超过 30 分钟号源可能作废，需重新取号\n"
            "  · 复诊患者可直接在自助机取号"
        ),
    },
    {
        "key": "payment",
        "keywords": ["缴费", "交费", "付款", "费用", "多少钱", "医保", "报销", "结算"],
        "text": (
            "【门诊缴费】\n"
            "缴费方式：\n"
            "  1. 线上：官方公众号 / APP → 门诊缴费，支持微信、支付宝、医保电子凭证\n"
            "  2. 自助机：各楼层自助服务区，支持银行卡、扫码\n"
            "  3. 人工窗口：一楼收费处（仅工作日 8:00-17:00）\n\n"
            "医保提示：\n"
            "  · 门诊统筹需在挂号时选择医保结算方式，否则本次费用无法补报\n"
            "  · 异地医保请先在参保地办理异地就医备案，到院后在窗口关联\n"
            "  · 发票可在自助机打印，或通过公众号查询电子票据\n"
            "  · 具体报销比例以参保地医保政策为准，医院不提供报销比例查询"
        ),
    },
    {
        "key": "report",
        "keywords": ["报告", "化验单", "检查结果", "结果出来", "拿报告", "取报告", "CT", "核磁", "B超", "化验"],
        "text": (
            "【报告查询与领取】\n"
            "线上查询（推荐）：\n"
            "  1. 官方公众号 → 就医服务 → 报告查询\n"
            "  2. 官方 APP → 我的报告\n"
            "  · 血常规、生化等常规检验：出结果后 2 小时内可查\n"
            "  · 影像类（CT/核磁/B超）：报告通常在检查后 1-2 个工作日发布\n\n"
            "线下打印：\n"
            "  · 门诊一楼、二楼自助打印机，凭就诊卡或身份证打印\n"
            "  · 病理类报告需到病理科窗口领取\n\n"
            "重要提示：\n"
            "  · 报告单只是检查数据的记录，解读必须由开单医生或对应科室医生完成\n"
            "  · 若报告中有标注「危急值」，医院会主动电话联系，请保持电话畅通\n"
            "  · 如需复诊看结果，请重新挂号对应科室"
        ),
    },
    {
        "key": "medical_record",
        "keywords": ["病历", "复印", "盖章", "病案"],
        "text": (
            "【病历复印】\n"
            "办理地点：病案室（住院部一楼，工作日 8:30-11:30 / 14:00-16:30）\n"
            "所需材料：患者本人身份证；代办需同时提供代办人身份证及委托书。\n"
            "收费：A4 纸 0.5 元/页。\n"
            "提示：住院病历一般在出院后 7 个工作日归档，归档后方可复印。"
        ),
    },
    {
        "key": "department",
        "keywords": ["在几楼", "哪个楼", "怎么走", "位置", "科室在哪", "导诊台"],
        "text": (
            "【科室位置指引】\n"
            "门诊楼（1 号楼）：\n"
            "  1 楼：挂号收费、药房、导诊台、急诊（东侧）\n"
            "  2 楼：内科（呼吸/消化/心血管/内分泌）、检验科\n"
            "  3 楼：外科（普外/骨科/泌尿）、换药室\n"
            "  4 楼：妇科、产科、儿科\n"
            "  5 楼：口腔科、眼科、耳鼻喉科、皮肤科\n"
            "  6 楼：中医科、康复科、体检中心\n"
            "住院部（2 号楼）：1 楼病案室、出入院办理处\n"
            "影像中心（3 号楼）：CT、核磁、DR、超声\n\n"
            "找不到位置可在一楼导诊台咨询，或使用院内导航小程序。"
        ),
    },
    {
        "key": "emergency",
        "keywords": ["急诊", "夜间", "晚上能看"],
        "text": (
            "【急诊服务】\n"
            "急诊科位于门诊楼 1 楼东侧，24 小时开放，节假日不休息。\n"
            "急诊按病情危重程度分级就诊，非急症患者可能需要等待较长时间。\n"
            "如出现胸痛、呼吸困难、大出血、意识不清、抽搐等情况，请直接到急诊科，"
            "或拨打 120 由救护车转运。"
        ),
    },
    {
        "key": "insurance_flow",
        "keywords": ["异地", "备案", "转诊"],
        "text": (
            "【异地就医】\n"
            "1. 在参保地医保经办机构或「国家医保服务平台」APP 办理异地就医备案；\n"
            "2. 到院后在门诊一楼医保窗口关联备案信息；\n"
            "3. 挂号、缴费时选择医保结算即可直接结算。\n"
            "未备案的异地患者需先自费，再回参保地手工报销，具体以参保地政策为准。"
        ),
    },
]

FALLBACK = (
    "【院内业务查询】\n"
    "暂未识别到具体的业务类型。您可以这样问我：\n"
    "  · “怎么预约挂号？”\n"
    "  · “检查报告在哪里拿？”\n"
    "  · “门诊怎么缴费，能用医保吗？”\n"
    "  · “内科在几楼？”\n"
    "如需人工协助，请拨打院内服务热线 96120。"
)


def answer_for(query: str) -> tuple[str, str]:
    q = query or ""
    for svc in SERVICES:
        for kw in svc["keywords"]:
            if kw in q:
                return svc["key"], svc["text"]
    return "fallback", FALLBACK


class Handler(BaseHTTPRequestHandler):
    def _send(self, text: str, status: int = 200):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send("医院业务查询 Mock 服务运行中。\nPOST /api/hospital/service  {\"query\": \"...\"}")

    def do_POST(self):
        if not self.path.startswith("/api/hospital/service"):
            self._send("Not Found", 404)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            data = json.loads(raw or "{}")
        except Exception:
            data = {}

        query = data.get("query") or data.get("q") or ""
        if isinstance(query, (dict, list)):
            query = json.dumps(query, ensure_ascii=False)

        service, text = answer_for(str(query))
        print("[mock] query=%r -> service=%s" % (query[:60], service), flush=True)
        self._send(text)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("医院业务 Mock 服务已启动: http://localhost:%d/api/hospital/service" % PORT, flush=True)
    server.serve_forever()
