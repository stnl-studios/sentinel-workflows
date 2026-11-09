CREATE TABLE dbo.Imported (
    Id int NOT NULL PRIMARY KEY,
    Payload nvarchar(100) NOT NULL
);
GO
CREATE TABLE dbo.ImportHistory (
    Id int IDENTITY(1,1) NOT NULL PRIMARY KEY,
    ImportedRows int NOT NULL
);
GO
CREATE TABLE dbo.Summary (
    Id int NOT NULL PRIMARY KEY,
    Total int NOT NULL
);
GO
CREATE TABLE dbo.DeploymentEvidence (
    Id int NOT NULL PRIMARY KEY,
    Marker nvarchar(100) NOT NULL
);
