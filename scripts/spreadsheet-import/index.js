const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const wordwrap = require('wordwrap')(80);
const chalk = require('chalk');
const program = require('commander');
const { promisify } = require('util');
const { getSheetData } = require('./spreadsheet-api');
const {
  processSheet,
  simplifySpreadsheetData
} = require('./spreadsheet-utils');
const rimraf = promisify(require('rimraf'));
const mkdirp = require('mkdirp');
const { downloadImage } = require('./image-download');
const slug = require('slug');

const timeout = promisify(setTimeout);

const secret = process.env.preview_filename_component || 'secret';

// spreadsheet-format is illustrated here:
//   https://docs.google.com/spreadsheets/d/14TQHTYePS0SAaXGRNF3zYXvvk8xz25CXW-uekQy4HAs/edit

program
  .description(
    'import speaker- and talk-data from the specified spreadheet and ' +
      'update the files in contents/speakers'
  )
  .arguments('<spreadsheet>')
  .action(spreadsheet => {
    const rxSpreadsheetIdFromUrl = /^https:\/\/docs\.google\.com\/.*\/d\/([^/]+).*$/;

    program.spreadsheetId = spreadsheet;

    if (rxSpreadsheetIdFromUrl.test(spreadsheet)) {
      program.spreadsheetId = spreadsheet.replace(rxSpreadsheetIdFromUrl, '$1');
    }
  })
  .option(
    '-p --production',
    "run in production-mode (don't import unpublished items)"
  )
  .option('-i --image-path <imagePath>', 'alternative path to look for images')
  .option('-C --no-cleanup', "don't run cleanup before import")
  .parse(process.argv);

const contentRoot = path.resolve(__dirname, '../../contents');
const sheetParams = {
  artists: {
    templateGlobals: {},
    dataFieldName: 'artist',
    contentPath: 'artists'
  },
  /*schedule: {
    templateGlobals: {},
    dataFieldName: 'schedule',
    contentPath: 'schedule'
  },*/
  speakers: {
    templateGlobals: {
      template: 'pages/speaker.html.njk'
    },
    dataFieldName: 'speaker',
    contentPath: 'speakers'
  },
  sponsors: {
    templateGlobals: {},
    dataFieldName: 'sponsor',
    contentPath: 'sponsors'
  },
  team: {
    templateGlobals: {},
    dataFieldName: 'team',
    contentPath: 'team'
  },
  articles: {
    templateGlobals: {
      template: 'pages/placeholder.html.njk'
    },
    dataFieldName: 'article',
    contentPath: 'news'
  }
};

const wwwtfrcFile = __dirname + '/../../.wwwtfrc';
const hasRcFile = fs.existsSync(wwwtfrcFile);

let rcFileParams = {};
if (hasRcFile) {
  rcFileParams = JSON.parse(fs.readFileSync(wwwtfrcFile));
}

const params = {
  ...rcFileParams,
  imagePath: program.imagePath,
  doCleanup: program.cleanup,
  publishedOnly: program.production || process.env.NODE_ENV === 'production'
};
if (program.spreadsheetId) {
  params.spreadsheetId = program.spreadsheetId;
}

if (!params.spreadsheetId) {
  console.log(
    chalk.red.bold('A spreadsheet-id (or spreadsheet-url) is required.')
  );
  program.outputHelp();
  process.exit(1);
}

if (!hasRcFile) {
  console.log('saving settings to', chalk.green('.wwwtfrc'));
  fs.writeFileSync(
    wwwtfrcFile,
    JSON.stringify({ spreadsheetId: params.spreadsheetId }, null, 2)
  );
}

main(params).catch(err => {
  console.error(chalk.red(err));
  process.exit(1);
});

function ensureDirExists(dir) {
  const fullDir = `${__dirname}/../../contents/${dir}`;
  if (fs.existsSync(fullDir)) {
    return;
  }
  mkdirp(fullDir);
}

async function main(params) {
  // ---- cleanup...
  if (params.doCleanup) {
    console.log(chalk.gray('cleaning up...'));

    await Promise.all([
      rimraf(
        path.join(contentRoot, '{artists,schedule,speakers,sponsors,team}/*md')
      )
    ]);
  }

  // ---- fetch spreadsheet-data...
  console.log(chalk.gray('loading spreadsheet data...'));
  const sheets = simplifySpreadsheetData(
    await getSheetData(params.spreadsheetId, {
      readonly: true,

      async beforeOpenCallback(url) {
        console.log(
          chalk.white(
            '\n\n🔐  You first need to grant access to your ' +
              'google-spreadsheets to this program.\n  An ' +
              'authorization-dialog will be ' +
              'opened in your browser in 5 seconds.\n\n'
          ),
          chalk.blue.underline(url)
        );

        return await timeout(5000);
      }
    })
  );

  // ---- parse and generate markdown-files
  console.log(chalk.gray('awesome, that worked.'));
  const previewFiles = [];
  const processedRecords = [];
  Object.keys(sheets).map(async function(sheetId) {
    if (!sheetId) {
      // Published pages create unnamed sheets.
      return;
    }
    if (!sheetParams[sheetId]) {
      console.log(chalk.red('Missing metadata for'), sheetId);
      return;
    }
    const { templateGlobals, dataFieldName, contentPath } = sheetParams[
      sheetId
    ];
    ensureDirExists(contentPath);
    const records = processSheet(sheets[sheetId]);

    console.log(chalk.white('processing sheet %s'), chalk.yellow(sheetId));
    processedRecords.push.apply(
      processedRecords,
      records.map(async function(record) {
        let { content = '', ...data } = record;
        let title = data.name;

        if (sheetId === 'speakers' && data.type === 'speaker') {
          title = `${data.name}: ${data.talkTitle}`;
        }

        if (sheetId === 'artists') {
          title = `${data.firstname} ${data.lastname}: ${data.talkTitle}`;
        }

        if (sheetId === 'team') {
          title = `${data.firstname} ${data.lastname}`;
        }

        if (!title) {
          title = 'missing title';
          console.error(chalk.red('Missing title'));
          console.dir(data);
        }

        let imageExtension = null;
        if (sheetId === 'sponsors') {
          imageExtension = 'svg';
        }
        const imageUrl = data.potraitImageUrl || data.logoUrl;
        data.image = await downloadImage(imageUrl, title, imageExtension);

        let frontmatterFromContent = {};

        if (content) {
          const extracted = extractFrontmatter(data, content);
          if (extracted) {
            content = extracted.content;
            frontmatterFromContent = extracted.frontmatter;
          }

          const imagesInContent = [];
          content = await downloadContentUrls(content, imagesInContent);
          if (!data.image.filename && imagesInContent.length) {
            data.image = imagesInContent[0];
          }
        }

        const metadata = {
          ...templateGlobals,
          title,
          ...frontmatterFromContent,
          [dataFieldName]: data
        };

        let cpath = contentPath;
        if (metadata.standalone) {
          cpath = 'cms';
          ensureDirExists(cpath);
        }

        let filename =
          sheetId === 'speakers' ? getFilename(data.name) : getFilename(title);
        if (!data.published && params.publishedOnly) {
          metadata.filename = ':file.html';
          cpath = 'preview';
          ensureDirExists(cpath);
          filename = `${filename}-${secret}`;
          previewFiles.push({
            url: `/${cpath}/${filename}.html`,
            name: data.name
          });
        }
        const fullpath = path.join(contentRoot, cpath, `${filename}.md`);

        console.log(
          ' --> write markdown %s',
          chalk.green(
            path.relative(process.cwd(), fullpath.replace(secret, '...'))
          )
        );

        const frontmatter = yaml.safeDump(metadata);
        try {
          const markdownContent =
            '----\n\n' +
            '# THIS FILE WAS GENERATED AUTOMATICALLY.\n' +
            '# CHANGES MADE HERE WILL BE OVERWRITTEN.\n\n' +
            frontmatter.trim() +
            '\n\n----\n\n' +
            wordwrap(content || '');

          fs.writeFile(fullpath, markdownContent, () => {
            /*fire and forget*/
          });
        } catch (err) {
          console.error('whoopsie', err);
        }
      })
    );
  });
  await Promise.all(processedRecords);
  ensureDirExists('preview');
  fs.writeFileSync(
    `${contentRoot}/preview/${secret}.md`,
    '----\n\ntemplate: pages/simple.html.njk\n' +
      'filename: :file.html\n\n----\n\n' +
      previewFiles
        .map(file => {
          return `<a href="${file.url}">${file.name}</a>`;
        })
        .join('<br>\n')
  );
}

function extractFrontmatter(data, content) {
  let frontmatterFromContent;
  if (!/^----*\n/.test(content.trim())) {
    return;
  }
  let sepCount = 0;
  let yamlString = '';
  let rest = '';
  content.split('\n').forEach(line => {
    if (/^----*$/.test(line)) {
      sepCount++;
      return;
    }
    if (sepCount >= 2) {
      rest += line + '\n';
      return;
    }
    yamlString += line + '\n';
  });
  if (sepCount != 2) {
    console.log(chalk.red('Incomplete frontmatter in'), data.name);
    return;
  }
  try {
    return {
      frontmatter: yaml.safeLoad(yamlString),
      content: rest
    };
  } catch (e) {
    console.log(chalk.red('Invalid frontmatter in'), data.name, e.message);
    return;
  }
}

function getFilename(name) {
  return slug(name.toLowerCase());
}

// Turn the text pattern DOWNLOAD(https://some.com/url)
// into a contents:images/cms/filename.jpg URL that is later
// resolved when rendering to the actual URL.
async function downloadContentUrls(text, imagesOut) {
  const imagePromises = [];
  const re = /DOWNLOAD\(([^\)]+)\)/g;
  text.replace(re, (match, url) => {
    imagePromises.push(downloadImage(url, 'image'));
  });
  const images = await Promise.all(imagePromises);
  let i = 0;
  text = text.replace(re, () => {
    const image = images[i++];
    let filename = image.filename;
    if (image.originalType == 'jpg') {
      filename = image.filename_1000;
    }
    return 'contents:images/cms/' + filename;
  });
  imagesOut.push.apply(imagesOut, images);
  return text;
}
