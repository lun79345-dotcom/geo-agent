"""Public edition contracts, created from synthetic fixtures in a temporary root."""
import http.client
import hashlib
from io import BytesIO
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from urllib import request
from unittest.mock import patch
from scripts import backend_server as backend
from scripts.offline_demo import simulate
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[2]

class OfflineGuardTests(unittest.TestCase):
    def test_standard_http_and_custom_opener_are_both_blocked(self):
        with self.assertRaisesRegex(RuntimeError, "公开演示版"):
            request.urlopen("https://example.com")
        with self.assertRaisesRegex(RuntimeError, "公开演示版"):
            request.build_opener().open("https://example.com")

    def test_cjk_fallback_is_available_without_windows_fonts(self):
        with patch.object(backend,'pdf_font_candidates',return_value=[]):
            self.assertEqual(backend.register_reportlab_font(),'STSong-Light')

class PublicDemoIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="geo-public-test-")
        cls.root = Path(cls.temp.name)
        for name in ('scripts','schema','assets','v2-assets'):
            if (ROOT/name).exists():
                shutil.copytree(ROOT/name, cls.root/name, ignore=shutil.ignore_patterns('__pycache__'))
        for name in ('02_doubao_question_bank.csv','07_doubao_first10_raw.md','10_fictional_fact_base.json','12_auto_analysis_results.json','16_sampling_runs.json','17_mock_sampling_raw.md','dashboard.html','portal.html'):
            if (ROOT/name).exists():shutil.copy2(ROOT/name,cls.root/name)
        env={**os.environ,'PYTHONUTF8':'1'}
        subprocess.run([sys.executable,'-m','scripts.import_fictional_demo_to_db'],cwd=cls.root,env=env,check=True,capture_output=True)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0)); cls.port=sock.getsockname()[1]
        env['GEO_AGENT_PORT']=str(cls.port)
        cls.log=(cls.root/'server.log').open('w',encoding='utf-8')
        cls.process=subprocess.Popen([sys.executable,'-m','scripts.run_demo'],cwd=cls.root,env=env,stdout=cls.log,stderr=cls.log)
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            try:
                if cls.call('GET','/api/status')[0]==200:return
            except OSError:pass
            if cls.process.poll() is not None:break
            time.sleep(.1)
        cls.log.flush()
        raise RuntimeError((cls.root/'server.log').read_text(encoding='utf-8'))

    @classmethod
    def tearDownClass(cls):
        if os.name == 'nt':
            # Windows venv launchers own a child interpreter; terminate this test's tree.
            subprocess.run(['taskkill','/PID',str(cls.process.pid),'/T','/F'],capture_output=True,check=False)
        else:
            cls.process.terminate()
        cls.process.wait(timeout=10);cls.log.close()
        for attempt in range(30):
            try:
                cls.temp.cleanup()
                return
            except PermissionError:
                if attempt == 29:raise
                time.sleep(.1)

    @classmethod
    def call(cls,method,path,payload=None):
        client=http.client.HTTPConnection('127.0.0.1',cls.port,timeout=10)
        body=json.dumps(payload).encode() if payload is not None else None
        client.request(method,path,body,{'Content-Type':'application/json'})
        response=client.getresponse();status=response.status;headers=dict(response.getheaders());raw=response.read();client.close()
        return status,headers,json.loads(raw) if headers.get('Content-Type','').startswith('application/json') else raw

    def test_fictional_workspace_and_samples_load(self):
        status,_,body=self.call('GET','/api/customers');self.assertEqual(status,200)
        self.assertTrue(all('虚构' in c['name'] for c in body['customers']))
        status,_,body=self.call('GET','/api/projects/proj_fictional_doubao_demo/samples?sample_type=mock')
        self.assertEqual(status,200);self.assertGreaterEqual(len(body['samples']),12)
        self.assertTrue(all(s['sample_type']=='mock' for s in body['samples']))

    def test_simulation_persists_linked_mock_run_and_never_real_samples(self):
        status,_,body=self.call('POST','/api/demo/simulate',{'project_id':'proj_fictional_doubao_demo'})
        self.assertEqual(status,200);self.assertTrue(body['is_mock']);self.assertEqual(body['sample_count'],12)
        with closing(sqlite3.connect(self.root/'data/geo_agent.db')) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM samples WHERE sample_type='real'").fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT count(*) FROM samples WHERE run_id=?',(body['run_id'],)).fetchone()[0],12)
            self.assertEqual(conn.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_credentials_cannot_be_saved_in_public_edition(self):
        for path in ('/api/llm-config','/api/sampler-config/doubao'):
            status,_,_=self.call('POST',path,{'api_key':'test-placeholder'})
            self.assertEqual(status,403)

    def test_private_files_are_not_served(self):
        for path in ('/data/geo_agent.db','/scripts/backend_server.py','/10_fictional_fact_base.json'):
            status,_,_=self.call('GET',path);self.assertIn(status,(403,404))

    def test_html_has_no_cache_and_portal_refuses_writes(self):
        status,headers,_=self.call('GET','/dashboard.html');self.assertEqual(status,200)
        self.assertIn('no-store',headers.get('Cache-Control',''))
        status,_,_=self.call('POST','/api/portal/projects',{});self.assertIn(status,(401,403))

    def test_frozen_report_pdf_is_valid_and_hash_verified(self):
        with closing(sqlite3.connect(self.root/'data/geo_agent.db')) as conn:
            version_id, expected_hash=conn.execute('SELECT report_version_id,pdf_sha256 FROM report_versions LIMIT 1').fetchone()
        status,_,pdf=self.call('GET',f'/api/projects/proj_fictional_doubao_demo/report-versions/{version_id}/pdf')
        self.assertEqual(status,200);self.assertTrue(pdf.startswith(b'%PDF'))
        self.assertEqual(hashlib.sha256(pdf).hexdigest(),expected_hash)
        reader=PdfReader(BytesIO(pdf));self.assertGreaterEqual(len(reader.pages),1)
        self.assertIn('虚构', ''.join(page.extract_text() for page in reader.pages))

    def test_demo_portal_login_uses_generated_fictional_account(self):
        status,headers,body=self.call('POST','/api/portal/auth/login',{'username':'demo-visitor','password':'fictional-demo-only'})
        self.assertEqual(status,200);self.assertEqual(body['customer_id'],'cust_fictional')
        self.assertIn('HttpOnly',headers.get('Set-Cookie',''))
