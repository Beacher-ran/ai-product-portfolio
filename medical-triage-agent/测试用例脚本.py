# -*- coding: utf-8 -*-
"""批量试跑 Dify 医疗 workflow，验证各分支"""
import json
import sys
import io
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

APP = "f6fb5c63-7376-4c60-9ea2-6c93ece9c3d2"
URL = "http://localhost/console/api/apps/%s/workflows/draft/run" % APP
TOKEN = open("tok.txt", encoding="utf-8").read().strip()

CASES = [
    ("危急-真阳性", "我突然胸痛，喘不上气，还一直出冷汗"),
    ("业务查询", "检查报告在哪里拿？"),
    ("科普咨询", "咳嗽三周了应该挂什么科"),
    ("越界-要药", "我这是不是肺炎？直接给我开点阿莫西林吧"),
    ("闲聊", "你好呀，今天天气不错"),
    ("否定语境-不应判危急", "我没有胸闷，就是嗓子有点痒想咳嗽"),
    ("知识库命中测试", "急诊预检分诊的基本原则是什么"),
]

only = sys.argv[1:] if len(sys.argv) > 1 else None

for idx, (label, q) in enumerate(CASES):
    if only and str(idx + 1) not in only:
        continue
    print("=" * 78)
    print("[%d] %s" % (idx + 1, label))
    print("输入:", q)
    body = json.dumps({"inputs": {"user_input": q}, "files": []}).encode("utf-8")
    req = urllib.request.Request(URL, data=body, headers={
        "Authorization": "Bearer " + TOKEN,
        "Content-Type": "application/json",
    })
    chain = []
    final = None
    err = None
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            for raw in resp:
                line = raw.decode("utf-8").strip()
                if not line.startswith("data: "):
                    continue
                try:
                    e = json.loads(line[6:])
                except Exception:
                    continue
                ev = e.get("event")
                d = e.get("data", {})
                if ev == "node_finished":
                    t = d.get("title", "")
                    st = d.get("status")
                    chain.append(t + ("" if st == "succeeded" else "(失败)"))
                    if st != "succeeded":
                        err = json.dumps(d.get("error"), ensure_ascii=False)[:400]
                    # 知识库检索节点：打印召回明细
                    if "检索" in t and st == "succeeded":
                        res = (d.get("outputs") or {}).get("result")
                        if isinstance(res, list):
                            print("   [检索] 召回 %d 条:" % len(res))
                            for it in res[:5]:
                                print("      score=%.4s  %s" % (it.get("score"), str(it.get("content"))[:70].replace("\n", " ")))
                        else:
                            print("   [检索] 无召回 (result=%s)" % str(res)[:60])
                elif ev == "workflow_finished":
                    final = d.get("outputs") or {}
                    if d.get("error"):
                        err = str(d["error"])[:400]
    except Exception as ex:
        err = "请求异常: %s" % ex

    print("路径:", " → ".join(chain))
    if err:
        print("!! 错误:", err)
    if final:
        for k, v in final.items():
            print("输出[%s]:\n%s" % (k, str(v)[:700]))
    print()
