document.getElementById('downloadForm').addEventListener('submit', async function(event) {
    event.preventDefault();
    const url = document.getElementById('url').value;
    const progressDiv = document.getElementById('progress');
    const progressValue = document.getElementById('progressValue');
    const progressBar = document.getElementById('progressBar');
    const resultDiv = document.getElementById('result');

    progressDiv.style.display = 'block';
    progressValue.textContent = '0%';
    progressBar.value = 0;

    resultDiv.textContent = '';

    try {
        const response = await fetch('/download', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ url }),
        });

        if (!response.ok) {
            throw new Error('Network response was not ok');
        }

        const reader = response.body.getReader();
        const contentLength = response.headers.get('Content-Length');
        let receivedLength = 0;
        let chunks = [];

        while(true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            receivedLength += value.length;

            if (contentLength) {
                const percent = (receivedLength / contentLength) * 100;
                progressValue.textContent = `${percent.toFixed(2)}%`;
                progressBar.value = percent;
            }
        }

        const blob = new Blob(chunks);
        const downloadUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = url.split('/').pop() + '.pdf';
        a.click();
        URL.revokeObjectURL(downloadUrl);

        progressValue.textContent = '100%';
        progressBar.value = 100;
        resultDiv.textContent = 'Download complete!';

        // Clear the input field
        document.getElementById('downloadForm').reset();

    } catch (error) {
        console.error('Error:', error);
        resultDiv.textContent = 'An error occurred during download.';
    }
});
