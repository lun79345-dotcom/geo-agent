"""Run the local-only public demo. Build the frontend before starting."""
import os,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
os.environ["GEO_AGENT_AUTH_ENABLED"]="false"
from scripts.backend_server import main
main()
