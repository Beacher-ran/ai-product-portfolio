@echo off
chcp 65001 >nul
title 医院业务查询 Mock 服务（医疗 AI-Workflow Demo 专用）
echo ==========================================================
echo   医院业务查询 Mock 服务
echo ----------------------------------------------------------
echo   接口地址: http://localhost:18080/api/hospital/service
echo   支持业务: 挂号 / 缴费 / 报告 / 病历复印 / 科室位置 / 急诊
echo.
echo   请保持本窗口开启。演示结束后关闭窗口即可停止服务。
echo ==========================================================
echo.

set PYEXE="D:\Software Download Position\python\python.exe"
if not exist %PYEXE% set PYEXE=python
set PYTHONIOENCODING=utf-8

%PYEXE% "%~dp0hospital_mock_server.py"

echo.
echo 服务已停止。
pause
