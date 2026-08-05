# syntax=docker/dockerfile:1

FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

# Restore in its own layer, keyed only on the project file, so adding art,
# audio or gameplay code doesn't re-resolve NuGet packages.
COPY Server/SwarmAndSnack.Server.csproj Server/
RUN dotnet restore Server/SwarmAndSnack.Server.csproj

COPY . .

# Packages came from the cached layer above; --no-restore stops publish from
# quietly resolving them again and throwing that cache away.
RUN dotnet publish Server/SwarmAndSnack.Server.csproj \
    -c Release \
    --no-restore \
    -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS runtime
WORKDIR /app

# The Web SDK publishes wwwroot as part of the output, so the client, the dock
# textures and the music in wwwroot/audio are all inside this copy. Static
# assets need no COPY of their own — if one goes missing in the container,
# check .dockerignore before adding a line here.
COPY --from=build /app/publish .

ENV ASPNETCORE_URLS=http://+:8080
ENV ASPNETCORE_ENVIRONMENT=Production
EXPOSE 8080

# Run unprivileged. The aspnet image defines APP_UID for this, and 8080 is
# above 1024 so an unprivileged process can still bind it.
USER $APP_UID

# No HEALTHCHECK here on purpose: this runtime image ships no curl or wget, so
# the usual one-liner would fail in a way that looks like the app is down. The
# server exposes GET /healthz — point the orchestrator's probe at that instead.

ENTRYPOINT ["dotnet", "SwarmAndSnack.Server.dll"]
