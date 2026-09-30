"""Create one explicitly fictional report and local visitor account."""
DEMO_VISITOR_USER = "demo-visitor"
DEMO_VISITOR_PASSWORD = "fictional-demo-only"

def report_model(backend):
    texts = {
        'conclusion': '本报告全部内容为虚构模拟，用于展示工作流。12 道示例题中 8 条模拟回答提及品牌。',
        'metrics': '模拟品牌出现率：67%；模拟推荐进入率：67%。这些数字不代表任何平台实际表现。',
        'scenes': '展示品类需求、服务商选择、竞品比较、采购决策四个观察场景。',
        'evidence': '模拟问题：示例城市有哪些企业视频服务商？模拟回答：星舟创意（虚构）可作为示例候选。',
        'causes': '部分模拟回答缺少目标品牌，演示事实覆盖不足的诊断思路。',
        'actions': '建立品牌事实页，明确服务范围、证据与更新日期。此行动仅用于演示。',
        'retest': '使用相同题目、配置和证据范围进行复测；公开版只生成虚构样本。',
        'appendix': '全部品牌、客户、回答和指标均为虚构。API 近似采样不能等同于客户端排名；本版禁止外部 API 请求。',
    }
    scenes=[{'id':key,'label':label,'sampleCount':3,'mentionRate':2/3,'recommendationRate':2/3,'evidenceCount':1} for key,label in [('demand_solution','品类需求可见'),('vendor_selection','推荐名单可见'),('budget_case_process','采购决策可见'),('competitor_compare','竞品对比可见')]]
    evidence=[{'id':'mock_evidence_1','questionId':'Q003','question':'中小企业如何选择创意视频团队？','sceneId':'vendor_selection','sceneLabel':'推荐名单可见','answerExcerpt':'【虚构模拟】云帆工作室（虚构）作为示例候选出现，回答未提及目标品牌。','brandMentioned':False,'brandRecommended':False,'competitors':['云帆工作室（虚构）'],'citations':[],'verifiedSources':[],'recommendedFix':'完善品牌事实页（模拟）','riskLevel':'低'}]
    return {'schemaVersion':3,'reportType':'client','title':'GEO Agent · 星舟创意虚构模拟报告','typeLabel':'模拟诊断报告','executiveSummary':texts['conclusion'], 'metrics':{'total_samples':12,'brand_mentions':8,'brand_recommendations':8,'brand_mention_rate':2/3,'brand_recommendation_rate':2/3,'missing_count':4,'competitor_pressure_count':4},'sections':[{'id':key,'title':title,'markdown':f'## {title}\n\n{texts[key]}','editable':key in backend.REPORT_EDITABLE_SECTION_IDS} for key,title in backend.REPORT_SECTION_LABELS.items()],'evidence':evidence,'allEvidence':evidence,'allAnomalies':evidence,'scenes':scenes,'actions':[],'sourceSnapshot':{'is_mock':True,'disclaimer':'虚构模拟报告'}}

def initialize(backend):
    with backend.db_connect() as conn:
        existing=conn.execute('SELECT 1 FROM report_versions WHERE project_id=? LIMIT 1',(backend.DEMO_PROJECT_ID,)).fetchone()
        project=backend.db_project_detail(conn,backend.DEMO_PROJECT_ID)
    if not project:return
    if not existing:
        report=report_model(backend)
        created=backend.db_create_project_report_draft(backend.DEMO_PROJECT_ID,{'report_type':'client','report':report,'section_status':{key:'reviewed' for key in backend.REPORT_SECTION_LABELS}})
        draft=created['draft']
        backend.db_publish_project_report_draft(backend.DEMO_PROJECT_ID,draft['draft_id'],{'revision':draft['revision'],'acknowledge_warnings':True})
    account=backend.db_customer_portal_account_payload(project['customer_id'])
    if not account.get('account'):
        backend.db_save_customer_portal_account(project['customer_id'],{'username':DEMO_VISITOR_USER,'password':DEMO_VISITOR_PASSWORD})
