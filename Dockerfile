# syntax=docker/dockerfile:1

FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src
COPY Server/SwarmAndSnack.Server.csproj Server/
RUN dotnet restore Server/SwarmAndSnack.Server.csproj
COPY . .
RUN dotnet publish Server/SwarmAndSnack.Server.csproj -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS runtime
WORKDIR /app
COPY --from=build /app/publish .
ENV ASPNETCORE_URLS=http://+:8080
ENV ASPNETCORE_ENVIRONMENT=Production
EXPOSE 8080
ENTRYPOINT ["dotnet", "SwarmAndSnack.Server.dll"]
