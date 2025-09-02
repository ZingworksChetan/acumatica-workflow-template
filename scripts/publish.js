'use strict';

const axios = require('axios');
const https = require('https');

// Configuration
const config = {
    baseUrl: process.env.AC_BASE_URL,
    validateOnly: process.env.VALIDATE_ONLY || false,
    auth: {
        name: process.env.AC_USERNAME,
        password: process.env.AC_PASSWORD,
        tenant: process.env.AC_TENANT,
        branch: process.env.AC_BRANCH,
        locale: "EN-US"
    },
    github: {
        token: process.env.GITHUB_TOKEN || '',
        tagPattern: new RegExp(process.env.TAG_PATTERN),
        repoMapping: {
            "USSBI/accu-united-site-services": "NAWUnitedSiteServices",
            "USSBI/acumatica-uss-fence-customizations": "AcumaticaUSSFenceCustomizations[2024R1]",
            "USSBI/acumatica-uss-fence": "USSFence"
        }
    },
    projects: {
        NAWUnitedSiteServices: process.env.NAWUnitedSiteServices?.toLowerCase() === 'true',
        AcumaticaUSSFenceCustomizations: process.env.AcumaticaUSSFenceCustomizations?.toLowerCase() === 'true',
        USSFence: process.env.USSFence?.toLowerCase() === 'true'
    }
};

// Initialize target array from config
const targetArray = Object.entries(config.projects)
    .filter(([_, value]) => value)
    .map(([key, _]) => key === 'AcumaticaUSSFenceCustomizations' ? `${key}[2024R1]` : key);

let cookies;

async function makeRequest(url, method = 'post', data = {}, extraHeaders = {}) {
    const headers = {
        'Content-Type': 'application/json',
        // 'User-Agent': 'axios/1.0',
        ...extraHeaders
    };

    if (cookies) {
        headers.Cookie = cookies.join('; ');
    }

    try {
        const response = await axios({ method, url, data, headers });
        return response;
    } catch (error) {
        console.error(`Error in ${method.toUpperCase()} ${url}:`, error.message);
        console.error(error);
        throw error;
    }
}

async function acumaticaLogout() {
    try {
        const response = await makeRequest(`${config.baseUrl}/entity/auth/logout`);
        console.log('Logout successful:', response.status);
    } catch (error) {
        console.error('Error during logout:', error.message);
    }
}

async function getPublished() {
    const response = await makeRequest(`${config.baseUrl}/CustomizationApi/GetPublished`);
    return response.data.projects;
}

async function publishLatestVersion(projectNames) {
    try {
        const publishData = {
            projectNames,
            isMergeWithExistingPackages: false,
            isOnlyValidation: config.validateOnly,
            isOnlyDbUpdates: false,
            isReplayPreviouslyExecutedScripts: false,
            tenantMode: "All"
        };

        await makeRequest(`${config.baseUrl}/CustomizationApi/PublishBegin`, 'post', publishData);
        const responseEnd = await makeRequest(`${config.baseUrl}/CustomizationApi/PublishEnd`);
        const summaryPath = process.env.GITHUB_STEP_SUMMARY;
        if (summaryPath) {
            const sorted = publishData.projectNames.sort((a, b) => a.localeCompare(b));

            const markdown = [
                `## Published Customizations for : ${process.env.ENVIRONMENT_NAME}`,
                '',
                ...sorted.map((item, index) => `${index + 1}. ${item}`)
            ].join('\n');

            console.log(markdown);
            // const summaryContent = `### Published Data for :${process.env.ENVIRONMENT_NAME}\n\`\`\`json\n${JSON.stringify(publishData.projectNames, null, 2)}\n\`\`\`\n`;
            require('fs').appendFileSync(summaryPath, markdown);
        }
        console.log('Publish End Response:', responseEnd.data);
    } catch (error) {
        console.error('Error in publishLatestVersion:', error);
        await acumaticaLogout();
        process.exit(1);
    }
}

async function loginToAcumatica() {
    try {
        const response = await makeRequest(
            `${config.baseUrl}/entity/auth/login`,
            'post',
            config.auth,
            { 'Accept': 'application/json' }
        );

        cookies = response.headers['set-cookie'];
        console.log('Set-Cookie values:', cookies);
        console.log('Login successful!');

        const publishedProjects = await getPublished();
        console.log('Published Projects:', publishedProjects);

        const results = await processRepositories();
        const replacementResult = replaceNamesWithLatestTags(results, targetArray);

        let newList = publishedProjects
            .map(project => project.name)
            .filter(name => !replacementResult.replacements
                .some(item => name.startsWith(item.targetName)));

        newList.push(...replacementResult.replacements.map(item => item.newVersion));
        console.log('Builds to Publish:', newList);

        await publishLatestVersion(newList);
    } catch (error) {
        console.error('Error during login process:', error);
        await acumaticaLogout();
        process.exit(1);
    } finally {
        await acumaticaLogout();
    }
}

function makeGitHubRequest(url) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                'User-Agent': 'Node.js-Tag-Fetcher',
                'Accept': 'application/vnd.github.v3+json',
            }
        };

        if (config.github.token) {
            options.headers['Authorization'] = `token ${config.github.token}`;
        }

        https.get(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (error) {
                        reject(new Error(`Failed to parse JSON: ${error.message}`));
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                }
            });
        }).on('error', reject);
    });
}

async function getRepositoryTags(repo) {
    try {
        console.log(`Fetching tags for ${repo}...`);
        const url = `https://api.github.com/repos/${repo}/tags?per_page=100`;
        const tags = await makeGitHubRequest(url);

        const matchingTags = tags
            .filter(tag => config.github.tagPattern.test(tag.name))
            .map(tag => ({
                name: tag.name,
                sha: tag.commit.sha,
                url: tag.commit.url
            }))
            .sort((a, b) => {
                const aVersion = parseInt(a.name.split('.').pop());
                const bVersion = parseInt(b.name.split('.').pop());
                return bVersion - aVersion;
            });

        if (matchingTags.length === 0) {
            console.log(`  No matching tags found for ${repo}`);
            return null;
        }

        const latestTag = matchingTags[0];
        console.log(`  Latest matching tag for ${repo}: ${latestTag.name}`);

        return {
            repository: repo,
            latestTag: latestTag.name,
            sha: latestTag.sha,
            totalMatchingTags: matchingTags.length,
            allMatchingTags: matchingTags.map(t => t.name)
        };
    } catch (error) {
        console.error(`Error fetching tags for ${repo}:`, error.message);
        return { repository: repo, error: error.message };
    }
}

async function processRepositories() {
    const repositories = Object.keys(config.github.repoMapping);
    const results = [];

    for (const repo of repositories) {
        const result = await getRepositoryTags(repo);
        if (result) results.push(result);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return results;
}

function replaceNamesWithLatestTags(results, targetArray) {
    const successful = results.filter(r => !r.error && r.latestTag);
    const updatedArray = [...targetArray];
    const replacements = [];

    successful.forEach(result => {
        const targetName = config.github.repoMapping[result.repository];
        if (!targetName) return;

        for (let i = 0; i < updatedArray.length; i++) {
            if (updatedArray[i] === targetName) {
                const originalName = updatedArray[i];
                updatedArray[i] = `${originalName}[${result.latestTag}]`;
                replacements.push({
                    repository: result.repository,
                    targetName,
                    originalName,
                    latestTag: result.latestTag,
                    newVersion: `${originalName}[${result.latestTag}]`,
                    index: i
                });
            }
        }
    });

    return { updatedArray, replacements, originalArray: targetArray };
}

// Start the process
loginToAcumatica();