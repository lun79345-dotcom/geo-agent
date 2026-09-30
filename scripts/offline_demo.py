"""Deterministic synthetic sampling for the public portfolio edition."""
def simulate(backend, project_id):
    with backend.db_connect() as conn:
        project = backend.db_project_detail(conn, project_id)
        if not project:
            raise ValueError("请选择一个演示项目")
        rows = conn.execute("SELECT q.question_id, q.question FROM project_questions pq JOIN question_pool q ON q.question_id=pq.question_id WHERE pq.project_id=? ORDER BY q.question_id LIMIT 40", (project_id,)).fetchall()
        if not rows:
            raise ValueError("项目中没有演示题目")
        run_id = backend.make_id("mock_run")
        timestamp = backend.now_iso()
        conn.execute("INSERT INTO sample_runs(run_id,project_id,name,platform,sampler,purpose,status,is_mock,created_at,started_at,completed_at) VALUES(?,?,?,'离线模拟','mock_doubao','exploration','completed',1,?,?,?)", (run_id, project_id, "虚构模拟采样 / 非平台回答", timestamp,timestamp,timestamp))
        for i,row in enumerate(rows):
            task_id=f"{run_id}_task_{i}"
            conn.execute("INSERT INTO sample_tasks(task_id,run_id,question_id,status,created_at,completed_at) VALUES(?,?,?,'success',?,?)",(task_id,run_id,row['question_id'],timestamp,timestamp))
            sample_id=f"{run_id}_sample_{i}"
            mentioned=i%3!=2
            brand=project.get('customer_name') or '示例品牌（虚构）'
            answer="【虚构模拟，非平台真实回答】"+(f"{brand}提供示例创意服务，可列为候选。请核验公开服务范围。" if mentioned else "本回答仅列出云帆工作室（虚构），未出现目标品牌。")
            conn.execute("INSERT INTO samples(sample_id,project_id,run_id,task_id,question_id,platform,answer_text,sample_type,collected_at) VALUES(?,?,?,?,?,'离线模拟',?,'mock',?)",(sample_id,project_id,run_id,task_id,row['question_id'],answer,timestamp))
            conn.execute("INSERT INTO analysis_results(analysis_id,sample_id,project_id,question_id,brand_mentioned,brand_recommended,risk_level,competitors_json,recommended_fix,analyzed_at,analyzer_version) VALUES(?,?,?,?,?,?,'低',?,?,?,'offline_demo_v1')",(f'{sample_id}_analysis',sample_id,project_id,row['question_id'],int(mentioned),int(mentioned),'[]' if mentioned else '["云帆工作室（虚构）"]','完善品牌事实页（模拟）',timestamp))
        return {'ok':True,'is_mock':True,'sample_count':len(rows),'run_id':run_id,'message':f'已生成 {len(rows)} 条虚构样本与规则分析，未调用任何平台 API。'}
