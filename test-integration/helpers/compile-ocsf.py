"""Compile the OCSF schema with ocsf-lib, on any supported Python.

Usage: compile-ocsf.py <ocsf-schema dir>   (the compiled schema goes to stdout)

ocsf-lib 0.10.4 (the latest release) calls typing.get_type_hints() on
dataclass instances. Up to Python 3.13 an instance's annotations fall through
to its class; Python 3.14 evaluates annotations lazily (PEP 649/749) and
refuses instances ("... does not have annotations"). This runs ocsf-lib's
compiler with that call given the instance's class, which yields the same
hints on every version. Remove it once ocsf-lib handles Python 3.14.
"""

import importlib
import runpy
import types
import typing


def _type_hints(obj, *args, **kwargs):
    if not isinstance(obj, (type, types.ModuleType)) and not callable(obj):
        obj = type(obj)
    return typing.get_type_hints(obj, *args, **kwargs)


# The module, not ocsf.compile.merge: the package re-exports a function of
# that name.
importlib.import_module("ocsf.compile.merge").get_type_hints = _type_hints
runpy.run_module("ocsf.compile", run_name="__main__", alter_sys=True)
