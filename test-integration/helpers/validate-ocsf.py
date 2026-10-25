"""Validate OCSF events (JSON lines) against an OCSF schema.

Used by `make -f Makefile-extras test-ocsf`. For each event it checks:

- the class, category, activity and type ids and their captions;
- that the event's schema version is the schema's version;
- every attribute exists in the class or object, with the right type and
  enum value, recursively;
- required attributes and "at least one of" constraints;
- that attributes from a profile are only used when the profile is listed
  in metadata.profiles.

Requirements and constraints come from the raw schema repository, because
the compiled schema (ocsf-lib) mislabels some core attributes with a
profile; types, enums and attribute lists come from the compiled schema.

usage: python3 validate-ocsf.py <compiled-schema.json> <ocsf-schema-repo> <events.jsonl>
"""
import json
import os
import sys

compiled = json.load(open(sys.argv[1]))
repo = sys.argv[2]
events = [json.loads(l) for l in open(sys.argv[3]) if l.strip()]

# Raw definitions, for requirement/profile/constraints (the compiled output
# mislabels some core attributes with a profile).
raw_events, raw_objects = {}, {}
for root, _, files in os.walk(os.path.join(repo, "events")):
    for f in files:
        if f.endswith(".json"):
            d = json.load(open(os.path.join(root, f)))
            raw_events[d["name"]] = d
for f in os.listdir(os.path.join(repo, "objects")):
    if f.endswith(".json"):
        d = json.load(open(os.path.join(repo, "objects", f)))
        raw_objects[d["name"]] = d

TYPES = compiled["types"]["attributes"] if "attributes" in compiled["types"] else compiled["types"]


def chain(raw, name):
    out = []
    while name:
        d = raw.get(name)
        if not d:
            break
        out.append(d)
        name = d.get("extends")
    return out


def raw_requirements(defs, profiles):
    """Required attributes and at_least_one constraints from raw definitions.
    The most derived definition wins for requirement/profile."""
    req = {}
    for d in reversed(defs):  # base first, derived overrides
        for k, v in d.get("attributes", {}).items():
            if k == "$include" or not isinstance(v, dict):
                continue
            cur = req.get(k, {})
            cur = {**cur, **{x: v[x] for x in ("requirement", "profile") if x in v}}
            req[k] = cur
    required = []
    for k, v in req.items():
        if v.get("requirement") == "required":
            prof = v.get("profile", None)
            if prof is None or prof in profiles:
                required.append(k)
    # The most derived definition's constraints replace inherited ones.
    constraints = []
    for d in defs:
        c = d.get("constraints")
        if c:
            if "at_least_one" in c:
                constraints.append(c["at_least_one"])
            break
    return required, constraints, req


def base_type(t):
    seen = set()
    while t in TYPES and t not in seen:
        seen.add(t)
        tt = TYPES[t]
        if tt.get("type") and tt["type"] != t:
            t = tt["type"]
        else:
            break
    return t


def check_value(path, attr, value, errors, profiles):
    t = attr.get("type")
    if attr.get("is_array"):
        if not isinstance(value, list):
            errors.append(f"{path}: expected array")
            return
        for i, v in enumerate(value):
            check_scalar(f"{path}[{i}]", attr, v, errors, profiles)
    else:
        check_scalar(path, attr, value, errors, profiles)


def check_scalar(path, attr, value, errors, profiles):
    t = attr.get("type")
    if t in ("object_t", "json_t", "object"):
        return
    if t in compiled["objects"]:
        if not isinstance(value, dict):
            errors.append(f"{path}: expected object {t}")
            return
        check_object(path, t, value, errors, profiles)
        return
    bt = base_type(t)
    ok = {
        "string_t": lambda v: isinstance(v, str),
        "integer_t": lambda v: isinstance(v, int) and not isinstance(v, bool),
        "long_t": lambda v: isinstance(v, int) and not isinstance(v, bool),
        "float_t": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
        "boolean_t": lambda v: isinstance(v, bool),
    }.get(bt)
    if ok and not ok(value):
        errors.append(f"{path}: {value!r} is not {t} ({bt})")
    enum = attr.get("enum")
    if enum and str(value) not in enum:
        errors.append(f"{path}: {value!r} not in enum {sorted(enum)}")


def check_attrs(path, defn_attrs, raw_defs, obj, errors, profiles):
    for k, v in obj.items():
        if k not in defn_attrs:
            errors.append(f"{path}.{k}: unknown attribute")
            continue
        check_value(f"{path}.{k}", defn_attrs[k], v, errors, profiles)
    required, constraints, req = raw_requirements(raw_defs, profiles)
    for k in required:
        if k not in obj:
            errors.append(f"{path}: missing required {k}")
    for group in constraints:
        if not any(g in obj for g in group):
            errors.append(f"{path}: needs at least one of {group}")
    # Profile use
    for k in obj:
        prof = req.get(k, {}).get("profile", "-")
        if prof == "-":
            prof = (defn_attrs.get(k) or {}).get("profile")
        if prof and prof not in profiles:
            errors.append(f"{path}.{k}: from profile {prof!r} not listed in metadata.profiles")
    # Sibling captions
    for k, v in obj.items():
        a = defn_attrs.get(k) or {}
        if k.endswith("_id") and a.get("enum") and a.get("sibling"):
            sib = a["sibling"]
            cap = a["enum"].get(str(v), {}).get("caption")
            if sib in obj and str(v) != "99" and obj[sib] != cap:
                errors.append(f"{path}.{sib}: {obj[sib]!r} should be {cap!r}")


def check_object(path, name, obj, errors, profiles):
    o = compiled["objects"][name]
    check_attrs(path, o["attributes"], chain(raw_objects, name), obj, errors, profiles)


bad = 0
for i, e in enumerate(events):
    errors = []
    cls = next((c for c in compiled["classes"].values() if c.get("uid") == e.get("class_uid")), None)
    code = (e.get("metadata") or {}).get("event_code")
    if not cls:
        print(f"[{i}] {code}: unknown class_uid {e.get('class_uid')}")
        bad += 1
        continue
    profiles = set((e.get("metadata") or {}).get("profiles") or [])
    if (e.get("metadata") or {}).get("version") != compiled.get("version"):
        errors.append(f"metadata.version {(e.get('metadata') or {}).get('version')!r} != schema {compiled.get('version')!r}")
    for p in profiles:
        if p not in cls.get("profiles", []):
            errors.append(f"profile {p!r} not supported by {cls['name']}")
    cat = compiled["categories"][cls["category"]]
    if e.get("category_uid") != cat["uid"]:
        errors.append(f"category_uid {e.get('category_uid')} != {cat['uid']}")
    if e.get("type_uid") != cls["uid"] * 100 + e.get("activity_id", -1):
        errors.append("type_uid != class_uid*100+activity_id")
    act = cls["attributes"]["activity_id"]["enum"].get(str(e.get("activity_id")))
    if act and e.get("activity_id") != 99 and e.get("activity_name") != act["caption"]:
        errors.append(f"activity_name {e.get('activity_name')!r} != {act['caption']!r}")
    if e.get("activity_id") == 99 and not e.get("activity_name"):
        errors.append("activity 99 requires activity_name")
    if e.get("class_name") != cls["caption"]:
        errors.append(f"class_name {e.get('class_name')!r} != {cls['caption']!r}")
    if e.get("category_name") != cat["caption"]:
        errors.append(f"category_name {e.get('category_name')!r} != {cat['caption']!r}")
    check_attrs("$", cls["attributes"], chain(raw_events, cls["name"]), e, errors, profiles)
    status = f"{cls['name']}/{e.get('activity_name')}"
    if errors:
        bad += 1
        print(f"[{i}] {code} ({status}): FAIL")
        for err in errors:
            print("     -", err)
    else:
        print(f"[{i}] {code} ({status}): ok")
print(f"\n{len(events) - bad}/{len(events)} events valid against OCSF {compiled.get('version')}")
sys.exit(1 if bad else 0)
