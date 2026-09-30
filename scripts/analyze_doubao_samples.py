"""Generic local rules for explicitly fictional demo answer sections."""
import json,re
from datetime import datetime,timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def main():
    fact=json.loads((ROOT/"10_fictional_fact_base.json").read_text(encoding="utf-8-sig"))
    brand=fact.get("entity",{}).get("brand_name","")
    text=(ROOT/"17_mock_sampling_raw.md").read_text(encoding="utf-8-sig")
    results=[]
    for qid,question,answer in re.findall(r"(?ms)^## (Q\d+) ([^\n]+)\n\n(.*?)(?=\n---|\Z)",text):
        mentioned=bool(brand and brand in answer)
        risks=[item.get("claim","") for item in fact.get("unsupported_or_forbidden_claims",[]) if item.get("claim") and item["claim"] in answer]
        results.append({"question_id":qid,"question":question,"brand_mentioned":mentioned,"brand_recommended":mentioned and "候选" in answer,"risk_level":"高" if risks else "低","competitors":[item["name"] for item in fact.get("competitor_watchlist",[]) if item.get("name") in answer],"accurate_claims":[],"unverified_claims":risks,"high_risk_hallucinations":[],"positioning_drift":[],"recommended_fix":"复核品牌事实与证据（模拟）"})
    total=len(results);mentions=sum(x["brand_mentioned"] for x in results);recommended=sum(x["brand_recommended"] for x in results)
    summary={"total_samples":total,"brand_mentions":mentions,"brand_recommendations":recommended,"brand_mention_rate":mentions/total if total else 0,"brand_recommendation_rate":recommended/total if total else 0,"high_risk_samples":sum(x["risk_level"]=="高" for x in results),"missing_core_questions":total-mentions}
    output={"generated_at":datetime.now(timezone.utc).isoformat(),"is_mock":True,"disclaimer":"虚构模拟规则分析，不代表平台回答","results":results,"summary":summary}
    (ROOT/"12_auto_analysis_results.json").write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(summary,ensure_ascii=False))
if __name__=="__main__":main()
