#!/usr/bin/env node
// 本番ビルド用ラッパー。VITE_API_BASE が未指定の場合、デプロイ済み SattoriStack の
// ApiUrl 出力を CloudFormation から自動取得して埋め込む（execute-api の URL は
// スタック作成後は不変なので、デプロイのたびに手で指定する必要をなくす）。
// 未デプロイ・AWS未認証などで取得できない場合は client.ts 側の既定値(/api)にフォールバックする。
import { spawnSync } from "node:child_process";

const STACK_NAME = "SattoriStack";
const REGION = "us-east-1";

function resolveApiBase() {
  if (process.env.VITE_API_BASE) return process.env.VITE_API_BASE;

  const result = spawnSync(
    "aws",
    [
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      STACK_NAME,
      "--region",
      REGION,
      "--query",
      "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue",
      "--output",
      "text",
    ],
    { encoding: "utf-8" },
  );

  const value = result.stdout?.trim();
  if (result.status !== 0 || !value || value === "None") {
    console.warn(
      `[build] ${STACK_NAME} の ApiUrl を取得できませんでした（未デプロイ or AWS未認証）。` +
        " VITE_API_BASE 未設定のままビルドします。",
    );
    return undefined;
  }
  console.log(`[build] VITE_API_BASE を自動検出: ${value}`);
  return value;
}

const apiBase = resolveApiBase();
const env = apiBase ? { ...process.env, VITE_API_BASE: apiBase } : process.env;

const vite = spawnSync("vite", ["build"], { stdio: "inherit", env });
process.exit(vite.status ?? 1);
