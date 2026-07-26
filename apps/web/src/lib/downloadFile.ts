/**
 * クロスオリジンのURLをディスクへ保存する。
 * `<a download>`のdownload属性はcrossオリジンのURLでは多くのブラウザ(Chrome等)で
 * 無視され、新しいタブでの表示(動画なら再生)にフォールバックしてしまう。
 * fetchで内容をBlobとして取得し、same-originなBlob URLに対してdownload属性を
 * 使うことで、ファイル名を指定したディスク保存を強制する。
 */
export async function downloadFile(url: string, filename: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`ダウンロードに失敗しました (status: ${response.status})`);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
