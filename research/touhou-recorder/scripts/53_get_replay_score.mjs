#!/usr/bin/env node
// リプレイファイル(.rpy)に記録された最終スコア等を取得する。
//
// `@sattori/touhou-replay-parser`(sattori モノレポの packages/replay-parser)を
// そのまま利用する。th06〜th20まで幅広くカバーしており(古い平文ヘッダ形式の
// th06/07/08、th10以降の共通USERブロック形式のth10/11/20を含む)、フェーズ50で
// th20向けに手書きしていたUSERセクションパーサ(`scripts/50_check_replay_desync.py`
// の`parse_replay_user_section()`)をタイトルごとに個別実装する必要がない。
//
// usage:
//   node scripts/53_get_replay_score.mjs <replay.rpy> [--json]
import {readFile} from 'node:fs/promises';
import {parseReplay} from '../../../packages/replay-parser/dist/index.js';

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const replayPath = args.find((a) => !a.startsWith('--'));

if (!replayPath) {
	console.error('usage: node scripts/53_get_replay_score.mjs <replay.rpy> [--json]');
	process.exit(2);
}

const data = new Uint8Array(await readFile(replayPath));
const result = parseReplay(data);

if (!result.ok) {
	console.error(`ERROR: ${result.error.code}: ${result.error.message}`);
	process.exit(1);
}

const {game, player, character, difficulty, stage, score, cleared, frameCount} = result.replay;

if (score === null || score === undefined) {
	console.error(`ERROR: ${replayPath} にスコアが記録されていません`);
	process.exit(1);
}

if (jsonOutput) {
	console.log(JSON.stringify({
		game, player, character, difficulty, stage, score, cleared, frameCount,
	}, null, 2));
} else {
	console.log(`game=${game} player=${player} character=${character} difficulty=${difficulty} stage=${stage} score=${score} cleared=${cleared} frameCount=${frameCount}`);
}
