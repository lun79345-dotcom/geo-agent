import unittest, tempfile, sqlite3, socket, json
from pathlib import Path
from unittest import mock
from io import BytesIO
from scripts import backend_server as backend_module
class DatabaseConnectionReliabilityTests(unittest.TestCase):
    def test_common_connection_uses_thirty_second_busy_timeout(self):
        with tempfile.TemporaryDirectory(prefix="geo-db-connect-") as tempdir:
            db_path = Path(tempdir) / "test.db"
            sqlite3.connect(db_path).close()
            with mock.patch.object(backend_module, "DB_FILE", db_path):
                with backend_module.db_connect() as connection:
                    busy_timeout = connection.execute(
                        "PRAGMA busy_timeout"
                    ).fetchone()[0]
            self.assertEqual(busy_timeout, 30000)

class PublicSourceUrlValidationTests(unittest.TestCase):
    def setUp(self):
        backend_module.SOURCE_FAKE_IP_MODE_CACHE = None

    def tearDown(self):
        backend_module.SOURCE_FAKE_IP_MODE_CACHE = None

    @staticmethod
    def address(ip, port=443):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))]

    def fake_ip_dns(self, hostname, port, **_kwargs):
        suffix = sum(ord(char) for char in hostname) % 200 + 1
        return self.address(f"198.18.0.{suffix}", port)

    def test_fake_ip_dns_mode_allows_public_domain_names(self):
        with mock.patch.object(backend_module.socket, "getaddrinfo", side_effect=self.fake_ip_dns):
            self.assertEqual(
                backend_module.validate_public_source_url("https://example.com/article"),
                "https://example.com/article",
            )

    def test_direct_ip_and_real_private_resolution_remain_blocked(self):
        with self.assertRaises(backend_module.PublicSourceSecurityError):
            backend_module.validate_public_source_url("http://127.0.0.1/private")

        def mixed_dns(hostname, port, **_kwargs):
            if hostname in backend_module.SOURCE_FAKE_IP_PROBE_HOSTS:
                return self.fake_ip_dns(hostname, port)
            return self.address("10.0.0.8", port)

        with mock.patch.object(backend_module.socket, "getaddrinfo", side_effect=mixed_dns):
            with self.assertRaises(backend_module.PublicSourceSecurityError):
                backend_module.validate_public_source_url("https://internal.example/private")

    def test_fetch_failure_categories_are_not_all_reported_as_unavailable(self):
        context = {"question_id": "Q001", "question": "测试问题", "answer_text": "测试回答"}
        citation = {"url": "https://example.com/not-found", "title": "测试来源"}
        with mock.patch.object(
            backend_module,
            "fetch_public_source_url",
            side_effect=backend_module.PublicSourceFetchError("网页读取失败：HTTP 404", "unavailable", 404),
        ):
            missing = backend_module.web_source_candidate(citation, "independent_web", context)
        self.assertEqual(missing["verification_status"], "unavailable")
        self.assertEqual(missing["metadata"]["http_status"], 404)

        with mock.patch.object(
            backend_module,
            "fetch_public_source_url",
            side_effect=backend_module.PublicSourceSecurityError("禁止访问本机、内网、链路本地或保留地址。"),
        ):
            blocked = backend_module.web_source_candidate(citation, "independent_web", context)
        self.assertEqual(blocked["verification_status"], "blocked")

    def test_historical_fake_ip_error_is_labeled_for_retry(self):
        item = backend_module.source_evidence_public_payload({
            "verification_status": "unavailable",
            "fetch_status": "unavailable",
            "metadata_json": json.dumps({"fetch_error": "禁止访问本机、内网、链路本地或保留地址。"}, ensure_ascii=False),
        })
        self.assertEqual(item["verification_status"], "blocked")
        self.assertEqual(item["verification_status_label"], "网络策略拦截")
        self.assertIn("重新核验", item["status_detail"])

    def test_search_snippet_cannot_replace_missing_page_excerpt(self):
        context = {"question_id": "Q001", "question": "千年舟提供什么服务", "answer_text": "千年舟提供板材服务"}
        citation = {"url": "https://example.com/article", "title": "测试来源", "snippet": "搜索结果声称千年舟提供板材服务"}
        fetched = {
            "url": citation["url"],
            "requested_url": citation["url"],
            "final_url": citation["url"],
            "redirect_chain": [],
            "text": "这是一个与当前问题完全无关的页面正文。",
            "content_type": "text/html",
        }
        with mock.patch.object(backend_module, "fetch_public_source_url", return_value=fetched):
            candidate = backend_module.web_source_candidate(citation, "independent_web", context)
        self.assertEqual(candidate["verification_status"], "raw")
        self.assertEqual(candidate["fetch_status"], "accessible")
        self.assertEqual(candidate["excerpt"], "")
        self.assertIn("未从页面原文", candidate["metadata"]["match_error"])

    def test_access_barrier_pages_are_rejected(self):
        self.assertTrue(
            backend_module.public_source_access_barrier_reason(
                "https://wappass.baidu.com/static/captcha/tuxing.html",
                "企业资料",
            )
        )
        self.assertTrue(
            backend_module.public_source_access_barrier_reason(
                "https://example.com/article",
                "访问过于频繁，请完成安全验证后继续。",
            )
        )
        self.assertEqual(
            backend_module.public_source_access_barrier_reason(
                "https://example.com/article",
                "这是可以公开访问的产品与服务正文。",
            ),
            "",
        )

    def test_redirect_metadata_is_preserved_for_valid_content(self):
        context = {"question_id": "Q001", "question": "板材服务", "answer_text": "提供板材服务"}
        citation = {"url": "https://example.com/start", "title": "测试来源"}
        fetched = {
            "url": "https://www.example.com/article",
            "requested_url": citation["url"],
            "final_url": "https://www.example.com/article",
            "redirect_chain": ["https://www.example.com/article"],
            "redirect_count": 1,
            "redirected_across_domain": True,
            "text": "公开页面说明该企业提供板材服务。",
            "content_type": "text/html",
        }
        with mock.patch.object(backend_module, "fetch_public_source_url", return_value=fetched):
            candidate = backend_module.web_source_candidate(citation, "independent_web", context)
        self.assertEqual(candidate["verification_status"], "matched")
        self.assertEqual(candidate["metadata"]["requested_url"], citation["url"])
        self.assertEqual(candidate["metadata"]["redirect_count"], 1)
        self.assertTrue(candidate["metadata"]["redirected_across_domain"])

class ReportSectionPolishValidationTests(unittest.TestCase):
    def result(self, section_id):
        return {
            "section_id": section_id,
            "section_title": "模型自定义标题",
            "section_markdown": "## 润色后的章节\n\n内容保持事实不变。",
            "change_summary": "已优化表达",
            "caveats": [],
        }

    def test_section_polish_normalizes_benign_model_id_variants(self):
        for returned_id in (None, "", "CONCLUSION", "本期诊断结论", "## 1. 本期诊断结论"):
            with self.subTest(returned_id=returned_id):
                normalized = backend_module.validate_report_section_polish_result(
                    self.result(returned_id),
                    "conclusion",
                )
                self.assertEqual(normalized["section_id"], "conclusion")
                self.assertEqual(normalized["section_title"], "本期诊断结论")

    def test_section_polish_keeps_requested_section_authoritative(self):
        normalized = backend_module.validate_report_section_polish_result(
            self.result("metrics"),
            "conclusion",
        )
        self.assertEqual(normalized["section_id"], "conclusion")
        self.assertTrue(normalized["section_id_normalized"])

    def test_section_polish_schema_pins_requested_section(self):
        schema = backend_module.report_section_polish_output_schema("actions")
        self.assertEqual(schema["properties"]["section_id"]["enum"], ["actions"])
        self.assertEqual(schema["properties"]["section_title"]["enum"], ["内容资产行动方案"])

class ReportEvidenceLockTests(unittest.TestCase):
    def test_source_selection_is_editable_but_source_facts_remain_locked(self):
        original = [{
            "id": "evidence-1",
            "questionId": "Q001",
            "verifiedSources": [{
                "id": "source-1",
                "title": "公开来源",
                "excerpt": "锁定的原文摘录",
                "selected": False,
            }],
        }]
        selection_changed = json.loads(json.dumps(original, ensure_ascii=False))
        selection_changed[0]["verifiedSources"][0]["selected"] = True
        self.assertEqual(
            backend_module.normalize_report_evidence_for_lock(original),
            backend_module.normalize_report_evidence_for_lock(selection_changed),
        )

        fact_changed = json.loads(json.dumps(selection_changed, ensure_ascii=False))
        fact_changed[0]["verifiedSources"][0]["excerpt"] = "被改写的原文"
        self.assertNotEqual(
            backend_module.normalize_report_evidence_for_lock(original),
            backend_module.normalize_report_evidence_for_lock(fact_changed),
        )