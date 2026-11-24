"""MCP-02 policy engine tests (pure): classification, args inspection, Gate 1 conditions G040-01/02/03/06/11."""
import pytest

from core.mcp.policy import (CLASSES, PolicyError, canonical, check_ids, classify, effective_args, offered_schema,
                             parse_access, parse_policy, registered_name, repo_in_scope, tool_sha256, load_policy)

H = "a" * 64


def pol(svc, tools):
    return parse_policy({"service": svc, "server_version": "1", "tools": tools}).tools


def one(tool, **kw):
    kw.setdefault("class", "write")
    return pol("github", {tool: kw})[tool]


# ---- load / format ----
def test_unknown_keys_fail():
    for bad in ({"service": "github", "server_version": "1", "x": 1},
                {"service": "github", "server_version": "1", "tools": {"t": {"class": "read", "bogus": 1}}},
                {"service": "github", "server_version": "1", "tools": {"t": {"class": "nope"}}},
                {"service": "github", "server_version": "1", "tools": {"t": {"class": "read", "tool_sha256": "zz"}}},
                {"service": "github", "server_version": "1", "tools": {"t": {"class": "read", "dispatch": {"arg": "a", "map": {"Up": "read"}}}}},
                {"service": "github", "server_version": "1", "tools": {"t": {"class": "read", "rules": [{"when": {"arg": "a", "present": True, "equals": 1}, "class": "settings"}]}}}):
        with pytest.raises(PolicyError):
            parse_policy(bad)


def test_unfilled_hash_ok_and_never_equals_live():
    tp = one("t", **{"class": "read"})
    assert tp.tool_sha256 == "" != tool_sha256({"name": "t"})


def test_load_policy_file(tmp_path):
    f = tmp_path / "p.toml"
    f.write_text('service="github"\nserver_version="2.2.0"\n[tools.issue_write]\nclass="write"\n')
    assert load_policy(f).tools["issue_write"].registered == "mcp_github_issue_write"
    f.write_text("not toml [")
    with pytest.raises(PolicyError):
        load_policy(f)
    with pytest.raises(PolicyError):
        load_policy(tmp_path / "missing.toml")


def test_registered_name():
    assert registered_name("clickup", "getTaskById") == "mcp_clickup_get_task_by_id"
    assert registered_name("hostinger", "multi-execute") == "mcp_hostinger_multi_execute"
    assert registered_name("github", "a/b") is None
    assert registered_name("github", "x" * 65) is None
    assert registered_name("github", "a" * 60) is None  # > 64 registered
    assert registered_name("github", "___") is None


def test_hash_stable_and_sensitive():
    t = {"name": "a", "description": "d", "inputSchema": {"type": "object"}}
    assert tool_sha256(t) == tool_sha256(dict(reversed(list(t.items()))))
    assert tool_sha256(t) != tool_sha256({**t, "description": "d "})
    assert canonical({"b": 1, "a": "é"}) == '{"a":"é","b":1}'


# ---- classification ----
def test_severity_never_lowered():
    tp = one("t", **{"class": "irreversible", "rules": [{"when": {"arg": "x", "present": True}, "class": "read"}]})
    assert classify(tp, {"x": 1})[0] == "irreversible"


def test_rule_casefold_rewrites_and_raises():
    tp = one("t", rules=[{"when": {"arg": "state", "equals": "closed"}, "class": "delete_recoverable"}])
    assert classify(tp, {"state": "open"})[0] == "write"
    cls, a = classify(tp, {"state": "  CLOSED "})
    assert cls == "delete_recoverable" and a["state"] == "closed"
    assert classify(tp, {"state": 5})[0] == "delete_recoverable"  # wrong type fails toward severity
    assert classify(tp, {})[0] == "write"


def test_present_semantics():
    tp = one("t", rules=[{"when": {"arg": "g", "present": True}, "class": "settings"}])
    assert classify(tp, {"g": False})[0] == "settings"
    assert classify(tp, {"g": None})[0] == "write"
    assert classify(tp, {})[0] == "write"


def test_in_contains_and_type_mismatch():
    tp = one("t", rules=[{"when": {"arg": "p.m", "contains": "delete"}, "class": "irreversible"}])
    assert classify(tp, {"p": {"m": "Bulk-DELETE"}})[0] == "irreversible"
    assert classify(tp, {"p": "oops"})[0] == "irreversible"  # intermediate not a dict
    assert classify(tp, {"p": {"m": "add"}})[0] == "write"
    tp = one("t", rules=[{"when": {"arg": "v", "in": ["Public", "domain"]}, "class": "settings"}])
    assert classify(tp, {"v": "PUBLIC"})[0] == "settings"


WF = [".github/workflows/**", ".github/actions/**", ".github/codeowners", "codeowners", ".github/dependabot.yml"]


@pytest.mark.parametrize("path", [
    ".github/workflows/ci.yml", ".GitHub/Workflows/ci.yml", "./.github/workflows/ci.yml",
    "a/../.github/workflows/ci.yml", ".github//workflows/ci.yml", ".github\\workflows\\ci.yml",
    "%2egithub/workflows/ci.yml", ".github%2Fworkflows%2Fci.yml", "%252egithub/workflows/x", "CODEOWNERS",
    "/.github/workflows/a/b.yml", "．github/workflows/ci.yml", ".github/dependabot.yml"])
def test_workflow_paths_raise_to_settings(path):
    tp = one("push_files", rules=[{"when": {"arg": "files[*].path", "glob": WF}, "class": "settings"}])
    assert classify(tp, {"files": [{"path": "README.md"}, {"path": path}]})[0] == "settings"


def test_workflow_path_wildcard_index_and_clean():
    tp = one("push_files", rules=[{"when": {"arg": "files[*].path", "glob": WF}, "class": "settings"}])
    assert classify(tp, {"files": [{"path": "src/a.py"}, {"path": "docs/CODEOWNERS.md"}]})[0] == "write"
    assert classify(tp, {"files": "x"})[0] == "settings"           # wrong shape
    assert classify(tp, {"files": [{"path": 5}]})[0] == "settings"  # wrong type
    tp1 = one("cf", rules=[{"when": {"arg": "path", "glob": WF}, "class": "settings"}])
    assert classify(tp1, {"path": ".github/workflows/x.yml"})[0] == "settings"


def test_dispatch_unknown_missing_blocked_and_rewrite():
    tp = one("manage_event", dispatch={"arg": "action", "map": {"create": "write", "delete": "delete_recoverable"}})
    assert classify(tp, {"action": "bogus"})[0] == "blocked"
    assert classify(tp, {})[0] == "blocked"
    assert classify(tp, {"action": ["create"]})[0] == "blocked"
    assert classify(tp, {"action": None})[0] == "blocked"
    cls, a = classify(tp, {"action": " DELETE\n"})
    assert (cls, a["action"]) == ("delete_recoverable", "delete")
    # casefold tricks: long-s folds to ascii, and the rewritten value is what is sent
    tp = one("execute", dispatch={"arg": "operation", "map": {"vps_virtual-machines_start": "write"}})
    cls, a = classify(tp, {"operation": "vps_virtual-machineſ_start"})
    assert cls == "write" and a["operation"] == "vps_virtual-machines_start"


def test_dispatch_then_rule_raise_only_and_blocked_tool():
    tp = one("manage_event", dispatch={"arg": "action", "map": {"create": "write"}},
             rules=[{"when": {"arg": "visibility", "equals": "public"}, "class": "settings"}])
    assert classify(tp, {"action": "create", "visibility": "PUBLIC"})[0] == "settings"
    tp = one("batch_update_doc", **{"class": "blocked"})
    assert classify(tp, {})[0] == "blocked"


def test_stripped_arg_present_is_blocked_unless_forced():
    tp = one("t", strip=["file_path"])
    assert classify(tp, {"file_path": "/etc/passwd"})[0] == "blocked"
    assert classify(tp, {"other": 1})[0] == "write"
    tp = one("t", strip=["user_google_email"], force={"user_google_email": "ai@x.com"})
    eff = effective_args(tp, {"user_google_email": "boss@x.com"}, "Pim")
    assert eff["user_google_email"] == "ai@x.com" and classify(tp, eff)[0] == "write"


def test_args_not_mutated_and_non_dict():
    tp = one("t", rules=[{"when": {"arg": "s", "equals": "x"}, "class": "settings"}])
    src = {"s": "X"}
    classify(tp, src)
    assert src == {"s": "X"}
    assert classify(tp, "str")[0] == "blocked"


# ---- G040-01 ids / scope ----
def gh():
    return one("issue_write", scope={"kind": "github_repo"})


@pytest.mark.parametrize("repo", ["dev-x/../../mkt", "..", ".", "a..b", "a/b", "a b", "", "x" * 101, "r\n", "r%2e", "é", 5, ["a"]])
def test_gh_repo_invalid_id(repo):
    with pytest.raises(PolicyError) as e:
        classify(gh(), {"owner": "org", "repo": repo})
    assert e.value.code == "invalid_id"


def test_gh_valid_and_absent():
    assert classify(gh(), {"owner": "Org", "repo": ".github"})[0] == "write"
    assert classify(gh(), {"repo": "ok"})[0] == "write"  # owner absent: scope step decides
    with pytest.raises(PolicyError):
        classify(gh(), {"owner": "../x", "repo": "ok"})


def test_other_id_kinds():
    cu = one("updateTask", scope={"kind": "clickup_space", "arg": "task_id"})
    for bad in ("a/../b", "a b", "x" * 65, "", "t\n", 7):
        with pytest.raises(PolicyError):
            check_ids(cu, {"task_id": bad})
    check_ids(cu, {"task_id": "86abc_-1"})
    gd = one("get", scope={"kind": "google_drive", "arg": ["file_id", "folder_id"]})
    check_ids(gd, {"file_id": "1AbC_-dEfGh", "folder_id": "1AbC_-dEfGh"})
    for bad in ("short", "1AbC_-dEfGh/..", "1AbC_-dEfGh\n"):
        with pytest.raises(PolicyError):
            check_ids(gd, {"file_id": bad})
    gc = one("ev", scope={"kind": "google_calendar", "arg": "calendar_id"})
    for ok in ("primary", "abc@group.calendar.google.com", "a.b+c@x.com"):
        check_ids(gc, {"calendar_id": ok})
    for bad in ("Primary", "a@", "@x.com", "a@b/../c", "a b@c.com", "x@y.com\n"):
        with pytest.raises(PolicyError):
            check_ids(gc, {"calendar_id": bad})


def hostinger(**kw):
    kw.setdefault("dispatch", {"arg": "operation", "map": {"vps_virtual-machines_start": "write",
                                                              "vps_docker_create": "settings"}})
    return pol("hostinger", {"execute": {"class": "write", "scope": {"kind": "hostinger_vm", "arg": "params.virtualMachineId"}, **kw}})["execute"]


@pytest.mark.parametrize("vm", ["1/../../billing", "1\\2", "1?x=1", "1#", "1%2e%2e", "../1", "abc", "", 1.5, True, -1, 10**12, "1" * 13])
def test_hostinger_vm_id_invalid(vm):
    with pytest.raises(PolicyError) as e:
        classify(hostinger(), {"operation": "vps_virtual-machines_start", "params": {"virtualMachineId": vm}})
    assert e.value.code == "invalid_id"


def test_hostinger_vm_id_valid_and_params_shape():
    op = "vps_virtual-machines_start"
    for vm in (123, "123"):
        assert classify(hostinger(), {"operation": op, "params": {"virtualMachineId": vm}})[0] == "write"
    with pytest.raises(PolicyError):  # params not an object
        classify(hostinger(), {"operation": op, "params": "x"})


@pytest.mark.parametrize("val", ["a/b", "a\\b", "a?b", "a#b", "a%2fb", "a..b", "x／y", "‥"])
def test_hostinger_params_paths_blocked_everywhere(val):
    op = "vps_virtual-machines_start"
    assert classify(hostinger(), {"operation": op, "params": {"n": val}})[0] == "blocked"
    assert classify(hostinger(), {"operation": op, "params": {"a": [{"b": val}]}})[0] == "blocked"
    assert classify(hostinger(), {"operation": op, "params": {val: "x"}})[0] == "blocked"


def test_hostinger_free_text_exempt_only_that_key():
    op = "vps_virtual-machines_start"
    tp = hostinger(free_text=["params.label"])
    assert classify(tp, {"operation": op, "params": {"label": "a/b"}})[0] == "write"
    assert classify(tp, {"operation": op, "params": {"other": "a/b"}})[0] == "blocked"


def test_hostinger_bypass_via_operation_is_unknown():
    for op in ("vps_virtual-machines_start/../billing", "billing_orders_create", "", None, 3):
        assert classify(hostinger(), {"operation": op, "params": {}})[0] == "blocked"
    assert classify(hostinger(), {"params": {}})[0] == "blocked"


def test_repo_in_scope_no_fnmatch_across_slash():
    assert repo_in_scope("org", "dev-x", "org", ["dev-*"])
    assert repo_in_scope("ORG", "Dev-X", "org", ["dev-*"])
    assert not repo_in_scope("org", "dev-x/../../org/mkt", "org", ["dev-*"])
    assert not repo_in_scope("org", "mkt", "org", ["dev-*"])
    assert not repo_in_scope("other", "dev-x", "org", ["dev-*"])
    assert not repo_in_scope("org", "dev-x", "org", ["*/dev-x", "org/*"])   # globs with "/" never match
    assert not repo_in_scope("org/dev-x", "..", "org", ["*"])
    assert not repo_in_scope("org", "x", "", ["*"])
    assert not repo_in_scope("org", "x", "org", [])


def test_access_parse():
    a = parse_access({"github_default_owner": "Org", "services": {"github": {"depts": ["DEV"]}},
                      "scopes": {"DEV": {"github_repos": ["dev-*"], "clickup_spaces": ["901"], "hostinger_vms": ["12"]}}})
    assert a.services["github"].depts == ("DEV",) and a.scopes["DEV"]["github_repos"] == ("dev-*",)
    for bad in ({"scopes": {"DEV": {"github_repos": ["org/*"]}}}, {"scopes": {"DEV": {"github_repos": ["a/../b"]}}},
                {"scopes": {"DEV": {"github_repos": ["[a-z]*"]}}}, {"scopes": {"DEV": {"clickup_spaces": ["a/b"]}}},
                {"scopes": {"dev": {}}}, {"scopes": {"DEV": {"oops": []}}}, {"services": {"github": {"depts": ["dev"]}}},
                {"github_default_owner": "a/b"}, {"zzz": 1}):
        with pytest.raises(PolicyError):
            parse_access(bad)


# ---- G040-02 hostinger settings ----
RECREATE_KEYS = ["password", "panel_password", "post_install_script_id", "public_key"]


@pytest.mark.parametrize("k", RECREATE_KEYS)
def test_recreate_with_credentials_is_settings(k):
    rules = [{"when": {"arg": f"params.{k}", "present": True}, "class": "settings"} for k in RECREATE_KEYS]
    tp = hostinger(dispatch={"arg": "operation", "map": {"vps_virtual-machines_recreate": "irreversible"}}, rules=rules)
    ok = {"operation": "vps_virtual-machines_recreate", "params": {"virtualMachineId": 5, "template_id": 1}}
    assert classify(tp, ok)[0] == "irreversible"
    ok["params"][k] = "x"
    assert classify(tp, ok)[0] == "settings"


def test_docker_create_update_settings_via_dispatch():
    tp = hostinger(dispatch={"arg": "operation", "map": {"vps_docker_create": "settings", "vps_docker_update": "settings"}})
    for op in ("vps_docker_create", "VPS_DOCKER_UPDATE"):
        assert classify(tp, {"operation": op, "params": {"virtualMachineId": 5}})[0] == "settings"


# ---- G040-03 / effective args ----
def test_force_and_variables():
    tp = one("create_repository", force={"private": True, "organization": "$github_default_owner"})
    a = effective_args(tp, {"name": "x", "private": False, "organization": "evil"}, "Tek", {"github_default_owner": "org"})
    assert a["private"] is True and a["organization"] == "org"
    with pytest.raises(PolicyError):
        effective_args(tp, {}, "Tek")
    assert classify(tp, a)[0] == "write"


def test_offered_schema_require_props():
    tp = one("fork_repository", require_props=["organization"], force={"organization": "org"})
    ok = {"type": "object", "properties": {"organization": {"type": "string"}}}
    assert offered_schema(tp, ok)["additionalProperties"] is False
    with pytest.raises(PolicyError):
        offered_schema(tp, {"type": "object", "properties": {}})


def test_attribution_bold_idempotent_and_foreign_prefix():
    tp = one("add_issue_comment", attribution=[{"field": "body", "style": "bold_prefix"}])
    a = effective_args(tp, {"body": "hi"}, "Tek")
    assert a["body"] == "**Tek:** hi"
    assert effective_args(tp, a, "Tek")["body"] == "**Tek:** hi"
    assert effective_args(tp, {"body": "**Pim:** hi"}, "Tek")["body"] == "**Tek:** **Pim:** hi"
    assert effective_args(tp, {}, "Tek") == {}
    with pytest.raises(PolicyError):
        effective_args(tp, {"body": 5}, "Tek")


def test_attribution_commit_and_set_if_absent():
    tp = one("create_issue", attribution=[{"field": "body", "style": "bold_prefix", "set_if_absent": True}])
    assert effective_args(tp, {}, "Tek")["body"] == "Created by Tek (AI)"
    assert effective_args(tp, {"body": "  "}, "Tek")["body"] == "Created by Tek (AI)"
    tp = one("push_files", attribution=[{"field": "message", "style": "commit_prefix"}])
    m = effective_args(tp, {"message": "fix"}, "Tek")["message"]
    assert m == "Tek (AI): fix" and effective_args(tp, {"message": m}, "Tek")["message"] == m
    assert effective_args(tp, {"message": "x"}, "T\n**ek**")["message"] == "T **ek** (AI): x"


# ---- G040-06 google schema ----
def gtool(**kw):
    return pol("google", {"t": {"class": "write", **kw}})["t"]


def test_google_pathish_props_need_strip_or_allow():
    sch = {"type": "object", "properties": {"file_id": {"type": "string"}, "image_source": {"type": "string"}}}
    with pytest.raises(PolicyError):
        offered_schema(gtool(), sch)
    with pytest.raises(PolicyError):
        offered_schema(gtool(strip=["image_source"]), sch)
    s = offered_schema(gtool(strip=["image_source"], allow_args=["file_id"]), sch)
    assert "image_source" not in s["properties"] and s["additionalProperties"] is False
    nested = {"type": "object", "properties": {"opts": {"type": "object", "properties": {"local_dir": {"type": "string"}}}}}
    with pytest.raises(PolicyError):
        offered_schema(gtool(), nested)


def test_offered_schema_strip_required_and_limits():
    tp = one("t", strip=["user_google_email"])
    sch = {"type": "object", "properties": {"a": {}, "user_google_email": {}}, "required": ["a", "user_google_email"]}
    out = offered_schema(tp, sch)
    assert out["required"] == ["a"] and "user_google_email" in sch["properties"]
    with pytest.raises(PolicyError):
        offered_schema(tp, {"type": "object", "properties": {"x": {"description": "d" * 17000}}})
    with pytest.raises(PolicyError):
        offered_schema(tp, {"type": "string"})


def test_classes_order():
    assert CLASSES == ("read", "write", "delete_recoverable", "irreversible", "settings", "payment", "blocked")


@pytest.mark.parametrize("path", [".github/./workflows/a.yml", ".github//workflows/a.yml", ".github%2Fworkflows%2Fa.yml",
                                  ".github/%2e/workflows/a.yml", "CODE%4FWNERS", ".github/dependabot.yaml"])
def test_g2t040_04_bypass_shapes_real_github_policy(path):
    from pathlib import Path
    p = load_policy(Path(__file__).resolve().parents[1] / "mcp" / "github" / "policy.toml")
    for t, a in (("create_or_update_file", {"path": path}), ("delete_file", {"path": path}),
                 ("push_files", {"files": [{"path": "README.md"}, {"path": path}]})):
        assert classify(p.tools[t], {"owner": "o", "repo": "r", **a})[0] == "settings", (t, path)
    assert classify(p.tools["push_files"], {"owner": "o", "repo": "r", "files": [{"path": "src/a.py"}]})[0] == "write"


def test_g2t040_12_google_ids_not_pathish_invalid():
    sch = {"type": "object", "properties": {"file_id": {"type": "string"}}}
    assert offered_schema(gtool(ids={"file_id": "google_file_id"}), sch)["additionalProperties"] is False
