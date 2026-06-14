-- Navicat / PostgreSQL 用: プロジェクト専用DBを作成
SELECT 'CREATE DATABASE gbp_content_manager'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'gbp_content_manager')\gexec
