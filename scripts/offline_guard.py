"""Process-wide HTTP guard for the public offline edition. No opt-out."""
from urllib import request
def blocked(*args, **kwargs):
    raise RuntimeError("公开演示版禁止外部网络请求；所有样本为虚构，不会调用付费 API。")
def install_offline_guard():
    request.urlopen = blocked
    request.OpenerDirector.open = blocked
