import os.path as osp
from collections import OrderedDict


def py_greet(name):
    return "hi " + name


def py_call_twice(name):
    return py_greet(name) + py_greet(name)


class PyGreeter:
    def py_greet(self, name):
        return py_greet(name)
