FROM node:24-slim AS base

ENV NODE_ENV=production

WORKDIR /app

# No install step: dist/index.js is a self-contained ncc bundle. Installing
# the dependencies here would add about 24 MB to the image, the Octokit stack
# first of all, that nothing in the image ever loads.
COPY dist /app/dist

RUN ln -s /app/dist/index.js /usr/local/bin/mankinds-ci \
 && chmod +x /app/dist/index.js

RUN useradd --create-home --uid 10001 mankinds
USER mankinds

ENTRYPOINT ["mankinds-ci"]
CMD ["--help"]

LABEL org.opencontainers.image.source="https://github.com/mankinds/cli" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.title="mankinds-ci" \
      org.opencontainers.image.description="Trigger a Mankinds AI quality gate from any CI (GitLab, CircleCI, Jenkins, Bitbucket, ...)."
