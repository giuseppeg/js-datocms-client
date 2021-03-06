import tmp from 'tmp';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import url from 'url';
import decode from '../../utils/decode';
import local from './nodeLocal';

export default function nodeUrl(client, fileUrl, options) {
  let isCancelled = false;
  let cancel = () => {
    isCancelled = true;
  };
  const promise = new Promise((resolve, reject) => {
    if (isCancelled) {
      return reject(new Error('upload aborted'));
    }
    return tmp.dir((err, dir, cleanupCallback) => {
      if (err) {
        reject(err);
      }

      const encodedFileUrl = decode(fileUrl);

      const cancelTokenSource = axios.CancelToken.source();
      cancel = () => {
        isCancelled = true;
        cancelTokenSource.cancel();
        cleanupCallback();
        reject(new Error('upload aborted'));
      };

      if (isCancelled) {
        return cancel();
      }

      return axios({
        url: encodedFileUrl,
        maxRedirects: 10,
        responseType: 'stream',
        cancelToken: cancelTokenSource.token,
        maxContentLength: 1000000000,
        maxBodyLength: 1000000000,
      })
        .then(async response => {
          let data;
          // Axios' onDownloadProgress works only in the browser
          // so in Node.js we need to implement it ourselves with streams.
          let onStreamEnd;
          const streamPromise = new Promise(_resolve => {
            onStreamEnd = _resolve;
          });
          const totalLength = response.headers['content-length'];
          const body = [];
          let progressLength = 0;
          response.data.on('data', chunk => {
            body.push(chunk);
            progressLength += chunk.length;
            if (options.onProgress) {
              options.onProgress({
                type: 'download',
                payload: {
                  percent: Math.round((progressLength * 100) / totalLength),
                },
              });
            }
          });
          response.data.on('end', () => {
            onStreamEnd(Buffer.concat(body));
          });
          response.data.on('error', reject);
          data = await streamPromise;

          /* eslint-disable no-underscore-dangle */
          const redirectedUrl =
            response.request._redirectable &&
            response.request._redirectable._redirectCount > 0
              ? response.request._redirectable._currentUrl
              : response.config.url;
          /* eslint-enable no-underscore-dangle */

          const { pathname } = url.parse(decode(redirectedUrl));
          const filePath = path.join(dir, path.basename(pathname));
          fs.writeFileSync(filePath, data);

          const { promise: uploadPromise, cancel: cancelUpload } = local(
            client,
            filePath,
            options,
          );
          cancel = () => {
            cancelUpload();
          };
          return uploadPromise.then(
            result => {
              fs.unlinkSync(filePath);
              cleanupCallback();
              resolve(result);
            },
            error => {
              fs.unlinkSync(filePath);
              cleanupCallback();
              throw error;
            },
          );
        })
        .catch(error => {
          if (error.response) {
            reject(
              new Error(
                `Invalid status code for ${encodedFileUrl}: ${error.response.status}`,
              ),
            );
          } else {
            reject(error);
          }
        });
    });
  });
  return {
    promise,
    cancel: () => {
      cancel();
    },
  };
}
